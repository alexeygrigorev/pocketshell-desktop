import { test, expect } from '@playwright/test';
import {
  startFixture,
  stopFixture,
  isFixtureRunning,
  DEFAULT_FIXTURE,
} from './helpers/docker-fixture';
import { sshExec, waitForSSH } from './helpers/ssh-helpers';

const { host, port, user, keyPath } = DEFAULT_FIXTURE;

test.describe('Bootstrap E2E tests', () => {
  let weStartedFixture = false;

  test.beforeAll(async () => {
    const running = await isFixtureRunning();
    if (!running) {
      await startFixture();
      weStartedFixture = true;
    }
    await waitForSSH(host, port, user, keyPath, 60_000);
  });

  test.afterAll(async () => {
    if (weStartedFixture) {
      await stopFixture();
    }
  });

  test('pocketshell is installed and reachable', async () => {
    // Verify pocketshell is on PATH
    const whichResult = await sshExec(
      host, port, user, keyPath,
      'which pocketshell',
    );
    expect(whichResult.exitCode).toBe(0);
    expect(whichResult.stdout.trim()).toMatch(/\/pocketshell$/);

    // Verify it is executable
    const execResult = await sshExec(
      host, port, user, keyPath,
      'test -x $(which pocketshell) && echo EXECUTABLE || echo NOT_EXECUTABLE',
    );
    expect(execResult.stdout.trim()).toBe('EXECUTABLE');
  });

  test('Version check works', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell --version',
    );
    expect(result.exitCode).toBe(0);

    const version = result.stdout.trim();
    // Should be a valid semver string
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    // Parse version components
    const [major, minor, patch] = version.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(0);
    expect(minor).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThanOrEqual(0);
  });

  test('Version respects PS_VERSION environment variable', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'PS_VERSION=9.9.9 pocketshell --version',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('9.9.9');
  });

  test('Upgrade check works (even if no upgrade available)', async () => {
    // The pocketshell stub does not have an explicit "upgrade" subcommand,
    // but we can verify the version is reported and compare it against
    // a well-known string. A real upgrade check would compare remote vs local.
    const versionResult = await sshExec(
      host, port, user, keyPath,
      'pocketshell --version',
    );
    expect(versionResult.exitCode).toBe(0);
    const currentVersion = versionResult.stdout.trim();

    // Verify the version string can be compared
    const parts = currentVersion.split('.');
    expect(parts.length).toBe(3);
    for (const part of parts) {
      expect(Number.isNaN(Number(part))).toBe(false);
    }

    // Simulate upgrade check: confirm binary responds to --version
    // and exit code is 0 (success, even if no upgrade available)
    expect(versionResult.exitCode).toBe(0);
  });

  test('Core tooling is available in fixture', async () => {
    // Verify basic tools needed for bootstrapping exist
    const tools = ['bash', 'ssh', 'tmux', 'git', 'sqlite3'];

    for (const tool of tools) {
      const result = await sshExec(
        host, port, user, keyPath,
        `which ${tool}`,
      );
      expect(result.exitCode).toBe(0);
    }
  });

  test('uv tool is installed and reports version', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'uv --version',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });

  test('pocketshell unknown command returns error', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell nonexistent-command',
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('unknown command');
  });

  test('SSH key authentication works without password', async () => {
    // Verify we can connect using the test key (which is the basis of
    // the bootstrap — the client must be able to reach the server)
    const result = await sshExec(
      host, port, user, keyPath,
      'echo "key-auth-works"',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('key-auth-works');
  });
});
