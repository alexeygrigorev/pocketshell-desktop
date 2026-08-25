import { beforeAll, afterAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { SshService } from '@main/ssh/SshService';
import { TmuxClientPool } from '@main/ssh/TmuxClientPool';
import type { ShellId } from '../../src/shared/types';
import { TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * The switch path against the real thing: real tmux, real tmuxctl, real sshd.
 *
 * The unit tests pin what the pool DECIDES; only this can say whether the
 * decision works — whether a tty published from inside a login-shell PTY can be
 * read back from a separate non-login exec channel, whether `switch-client`
 * finds that client, and whether the pane the renderer is holding actually ends
 * up showing the other session's contents.
 *
 * The helper image is used rather than `:tmux` because tmuxctl is what the join
 * runs, and the point of the handshake is that a raw `tmux` in an exec channel
 * reaches the same server tmuxctl attached to.
 *
 * Auto-skips when Docker is unavailable.
 */
describeDocker('tmux switch-client session switching', () => {
  let container: StartedTestContainer | undefined;
  let ssh: SshService;
  let pool: TmuxClientPool;
  let connectionId: string;

  /** Everything the shared PTY has emitted, per shell id. */
  const output = new Map<ShellId, string>();

  const sink = {
    onData: (shellId: ShellId, data: Buffer) => {
      output.set(shellId, (output.get(shellId) ?? '') + data.toString('utf8'));
    },
    onExit: () => {},
  };

  /** A line the session prints, so seeing it proves that session is on screen. */
  const marker = (session: string) => `MARK-${session.toUpperCase()}`;

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:helper')
      .withExposedPorts(22)
      .start();
    ssh = new SshService();
    const result = await ssh.connect({
      host: container.getHost(),
      port: container.getMappedPort(22),
      user: 'testuser',
      privateKeyPath: TEST_KEY_PATH,
      knownHosts: null,
      tofuDecision: 'accept-once',
      timeoutMs: 15_000,
    });
    if (!result.ok || !result.connectionId) throw new Error('connect failed');
    connectionId = result.connectionId;
    pool = new TmuxClientPool(ssh);

    // Three detached sessions, each showing a distinguishable line. `send-keys`
    // rather than a start command so the marker sits in the pane's visible
    // screen, which is what a switch redraws.
    for (const name of ['sw-one', 'sw-two', 'sw-three']) {
      await ssh.exec(connectionId, `tmux new-session -d -s ${name} -c "$HOME" 2>/dev/null || true`);
      await ssh.exec(
        connectionId,
        `tmux send-keys -t ${name} 'clear; echo ${marker(name)}' Enter`,
      );
    }
  }, 180_000);

  afterAll(async () => {
    if (connectionId) ssh.close(connectionId);
    if (container) await container.stop();
  });

  /** Resolve once `needle` shows up in the shell's accumulated output. */
  function waitForOutput(shellId: ShellId, needle: string, timeoutMs = 15_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = (): void => {
        const acc = output.get(shellId) ?? '';
        if (acc.includes(needle)) resolve(acc);
        else if (Date.now() - start > timeoutMs) {
          reject(new Error(`timed out waiting for ${needle}; last 300: ${acc.slice(-300)}`));
        } else setTimeout(tick, 50);
      };
      tick();
    });
  }

  it('joins once and then switches, keeping the same PTY', async () => {
    const first = await pool.attach(connectionId, 'sw-one', { cols: 80, rows: 24, ...sink });
    expect(first.switched).toBe(false);
    await waitForOutput(first.shellId, marker('sw-one'));

    // The handshake has to have survived the trip: written by a login shell in
    // a PTY channel, read by a non-login exec channel. If it did not, this
    // comes back as a fresh join with a different id.
    const second = await pool.attach(connectionId, 'sw-two', { cols: 80, rows: 24, ...sink });
    expect(second.switched).toBe(true);
    expect(second.shellId).toBe(first.shellId);

    // And the pane genuinely shows the other session, not just a happy exit code.
    await waitForOutput(first.shellId, marker('sw-two'));

    const third = await pool.attach(connectionId, 'sw-three', { cols: 80, rows: 24, ...sink });
    expect(third.shellId).toBe(first.shellId);
    await waitForOutput(first.shellId, marker('sw-three'));

    expect(pool.currentSession(connectionId)).toBe('sw-three');
  }, 90_000);

  it('leaves any other client on the host alone', async () => {
    // A user with their own terminal attached to the same tmux server is the
    // reason the switch names its client with -c instead of letting tmux pick
    // a "best" one. Attach a decoy to sw-one and switch ours elsewhere.
    const decoy = await ssh.openTrackedShell(connectionId, {
      command: 'tmux attach-session -t sw-one',
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    await new Promise((r) => setTimeout(r, 1500));

    const ours = await pool.attach(connectionId, 'sw-two', { cols: 80, rows: 24, ...sink });
    expect(ours.switched).toBe(true);

    const clients = await ssh.exec(
      connectionId,
      `tmux list-clients -F '#{client_tty}=#{client_session}'`,
    );
    const sessions = clients.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('=')[1]);
    // Two clients, on two different sessions: ours moved, theirs did not.
    expect(sessions).toContain('sw-one');
    expect(sessions).toContain('sw-two');

    ssh.shellClose(decoy);
  }, 60_000);

  it('re-joins rather than stranding the pane when the session is gone', async () => {
    await pool.attach(connectionId, 'sw-two', { cols: 80, rows: 24, ...sink });
    const before = pool.currentSession(connectionId);
    expect(before).toBe('sw-two');

    const gone = await pool.attach(connectionId, 'sw-does-not-exist', {
      cols: 80,
      rows: 24,
      ...sink,
    });
    // switch-client says `can't find session`, so the pool throws the client
    // away and joins — which surfaces the documented join diagnostic in the
    // PTY instead of silently leaving the user on the previous session.
    expect(gone.switched).toBe(false);
    await waitForOutput(gone.shellId, 'could not join session');
  }, 90_000);

  it('re-joins after the user detaches the client from inside tmux', async () => {
    const held = await pool.attach(connectionId, 'sw-one', { cols: 80, rows: 24, ...sink });
    await waitForOutput(held.shellId, marker('sw-one'));

    // prefix-d, as a user would. detach-client by tty is the same operation.
    const tty = await ssh.exec(
      connectionId,
      `tmux list-clients -F '#{client_tty}' | tail -1`,
    );
    await ssh.exec(connectionId, `tmux detach-client -t '${tty.stdout.trim()}'`);
    await new Promise((r) => setTimeout(r, 800));

    const after = await pool.attach(connectionId, 'sw-two', { cols: 80, rows: 24, ...sink });
    // The old PTY is back at a login prompt with no client on it, so the switch
    // cannot work and must degrade to what the app always did.
    expect(after.switched).toBe(false);
    expect(after.shellId).not.toBe(held.shellId);
    await waitForOutput(after.shellId, marker('sw-two'));
  }, 90_000);
});
