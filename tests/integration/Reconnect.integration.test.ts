import { beforeAll, afterAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { SshService } from '@main/ssh/SshService';
import { TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * Reconnect integration against the flaky fixture.
 *
 * The `pocketshell-test:flaky` image kills the per-connection sshd handlers
 * every PS_FLAKY_INTERVAL_SEC seconds, so the drop under test is a REAL one —
 * error/close on the wire, the registry record torn down,
 * `onCloseConnection` firing with reason 'lost' — on a deterministic
 * schedule. The listener survives the kills (see flaky-entrypoint.sh), which
 * is what makes the second half meaningful: the re-dial goes to the SAME
 * sshd and must round-trip bytes again.
 *
 * This exercises main's half of F12 — drop detection plus a fresh dial. The
 * renderer's FSM that decides WHEN to redial is unit-tested in
 * tests/unit/connectionAutoReconnect.test.ts.
 */
describeDocker('Reconnect against the flaky fixture', () => {
  /** Generous window: the first kill lands ~5s after container start. */
  const DROP_TIMEOUT_MS = 30_000;

  let container: StartedTestContainer | undefined;
  let host: string;
  let port: number;
  let ssh: SshService;

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:flaky')
      .withEnvironment({ PS_FLAKY_INTERVAL_SEC: '5' })
      .withExposedPorts(22)
      .start();
    host = container.getHost();
    port = container.getMappedPort(22);
    ssh = new SshService();
  }, 120_000);

  afterAll(async () => {
    if (container) await container.stop();
  });

  function dial(): Promise<{ ok: boolean; connectionId?: string; error?: string }> {
    return ssh.connect({
      host,
      port,
      user: 'testuser',
      privateKeyPath: TEST_KEY_PATH,
      knownHosts: null,
      tofuDecision: 'accept-once',
      timeoutMs: 15_000,
    });
  }

  it('reports the forced drop as lost, then reconnects to the same host', async () => {
    const first = await dial();
    expect(first.ok).toBe(true);
    const firstId = first.connectionId!;

    let off: (() => void) | undefined;
    const lost = new Promise<string>((resolve) => {
      off = ssh.onCloseConnection((id, reason) => {
        if (id === firstId) resolve(reason);
      });
    });

    const reason = await Promise.race([
      lost,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('no forced drop within the window')), DROP_TIMEOUT_MS),
      ),
    ]);
    // 'lost', not 'user': the distinguishing the whole close-reason plumbing
    // exists for. A drop that reported as a user disconnect would break the
    // banner's wording and skip the auto-reconnect in the renderer.
    off?.();
    expect(reason).toBe('lost');

    // The record is gone; a call against it is a hard unknown-id error, not a
    // hang — the renderer's store never makes such calls against a dead id
    // without re-dialling first.
    await expect(ssh.exec(firstId, 'whoami')).rejects.toThrow();

    // Re-dial — what the renderer's FSM does on the same schedule trigger —
    // and prove the fixture still answers.
    const second = await dial();
    expect(second.ok).toBe(true);
    const res = await ssh.exec(second.connectionId!, 'whoami');
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('testuser');
    ssh.close(second.connectionId!);
  });
});
