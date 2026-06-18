import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { SshService } from '@main/ssh/SshService';
import { TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * Integration test for the tracked-shell (terminal) path against the
 * `pocketshell-test:tmux` image: open a PTY shell, feed it input, and assert
 * the echoed output streams back. Also covers `tmux attach`. This is the
 * main->preload->renderer data path (minus the IPC broadcast) that powers
 * the xterm.js terminal view.
 *
 * Auto-skips when Docker is unavailable.
 */
describeDocker('Tracked shell (terminal) integration', () => {
  let container: StartedTestContainer | undefined;
  let ssh: SshService;
  let connectionId: string | undefined;

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:tmux')
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
  }, 120_000);

  afterAll(async () => {
    if (connectionId) ssh.close(connectionId);
    if (container) await container.stop();
  });

  /**
   * Open a tracked shell, send `command`, and resolve once `sentinel`
   * appears in the accumulated stdout (or after `timeoutMs`). Returns the
   * full accumulated output.
   */
  async function runUntilSentinel(opts: {
    command?: string;
    sentinel: string;
    input: string;
    settleMs?: number;
    timeoutMs?: number;
  }): Promise<string> {
    const { command, sentinel, input, settleMs = 300, timeoutMs = 6000 } = opts;
    let acc = '';
    const shellId = await ssh.openTrackedShell(connectionId!, {
      command,
      onData: (data) => {
        acc += data.toString('utf8');
      },
      cols: 80,
      rows: 24,
    });
    await new Promise((r) => setTimeout(r, settleMs));
    ssh.shellInput(shellId, input);
    const output = await new Promise<string>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (acc.includes(sentinel) || Date.now() - start > timeoutMs) {
          ssh.shellClose(shellId);
          resolve(acc);
        } else {
          setTimeout(tick, 50);
        }
      };
      tick();
    });
    return output;
  }

  it('opens a bare shell and round-trips echo', async () => {
    const output = await runUntilSentinel({
      sentinel: 'SENTINEL_ECHO',
      input: 'echo SENTINEL_ECHO\n',
    });
    expect(output).toContain('SENTINEL_ECHO');
  }, 15_000);

  it('attaches to a tmux session and renders its output', async () => {
    // Create a detached session first so `tmux attach` has a target.
    await ssh.exec(connectionId!, 'tmux new-session -d -s integ 2>/dev/null || true');
    const output = await runUntilSentinel({
      command: 'tmux attach -t integ',
      sentinel: 'TMUX_SENTINEL',
      input: 'echo TMUX_SENTINEL\n',
      settleMs: 600, // give tmux time to render the attach
    });
    expect(output).toContain('TMUX_SENTINEL');
  }, 20_000);

  it('resizes the PTY via shellResize without error', async () => {
    const shellId = await ssh.openTrackedShell(connectionId!, {
      onData: () => {},
      cols: 80,
      rows: 24,
    });
    expect(() => ssh.shellResize(shellId, 120, 40)).not.toThrow();
    ssh.shellClose(shellId);
  });
});
