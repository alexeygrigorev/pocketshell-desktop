import { beforeAll, afterAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { SshService } from '@main/ssh/SshService';
import { PocketshellClient } from '@main/helper/PocketshellClient';
import { runBootstrap } from '@main/helper/bootstrap';
import { TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * Integration tests for the `pocketshell` helper client against the real
 * `pocketshell-test:helper` image (which installs the actual `pocketshell`
 * CLI + tmuxctl + stub agents + seeded fixtures). Exercises the real
 * `pocketshell sessions list` / `usage` paths plus the
 * bootstrap probe.
 *
 * Auto-skips when Docker is unavailable.
 */
describeDocker('PocketshellClient integration', () => {
  let container: StartedTestContainer | undefined;
  let ssh: SshService;
  let helper: PocketshellClient;
  let connectionId: string | undefined;

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
    helper = new PocketshellClient(ssh);
    // Give the entrypoint's seeded tmux sessions a moment to come up.
    await new Promise((r) => setTimeout(r, 1500));
  }, 120_000);

  afterAll(async () => {
    if (connectionId) ssh.close(connectionId);
    if (container) await container.stop();
  });

  it('bootstrap detects pocketshell + tmux + uv', async () => {
    const boot = await runBootstrap(ssh, connectionId!);
    expect(boot.pocketshell.installed).toBe(true);
    expect(boot.pocketshell.path).toMatch(/pocketshell$/);
    expect(boot.tmux.installed).toBe(true);
    expect(boot.installer).toBe('uv');
  });

  it('listSessions returns the seeded tmux sessions', async () => {
    const sessions = await helper.listSessions(connectionId!, 'activity');
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    const names = sessions.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['main', 'build']));
  });

  it('createSession + listSessions reflects the new session', async () => {
    const name = `test-${Date.now()}`;
    const created = await helper.createSession(connectionId!, { name, cwd: '$HOME' });
    expect(created.ok).toBe(true);
    // The helper echoes the resolved name back on stdout.
    expect(created.name).toBe(name);
    const sessions = await helper.listSessions(connectionId!, 'activity');
    expect(sessions.map((s) => s.name)).toContain(name);
  });

  it('createSession is idempotent — a second create is a no-op success', async () => {
    const name = `test-idem-${Date.now()}`;
    const first = await helper.createSession(connectionId!, { name, cwd: '$HOME' });
    const second = await helper.createSession(connectionId!, { name, cwd: '$HOME' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.name).toBe(name);
    const sessions = await helper.listSessions(connectionId!, 'activity');
    expect(sessions.filter((s) => s.name === name)).toHaveLength(1);
  });

  it('reposList reports gh-missing for the remote scope instead of failing', async () => {
    const local = await helper.reposList(connectionId!, { scope: 'local' });
    expect(local.state).toBe('ok');
    const remote = await helper.reposList(connectionId!, { scope: 'remote' });
    // The fixture image ships no `gh`; that is a normal host state.
    expect(remote.state).toBe('gh-missing');
    expect(remote.repos).toEqual([]);
  });

  it('usage returns the seeded provider rows', async () => {
    const rows = await helper.usage(connectionId!);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const providers = rows.map((r) => r.provider);
    expect(providers).toEqual(expect.arrayContaining(['codex', 'claude', 'copilot']));
  });
});
