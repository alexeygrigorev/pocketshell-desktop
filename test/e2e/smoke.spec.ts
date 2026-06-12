import { test, expect } from '@playwright/test';
import {
  startFixture,
  stopFixture,
  isFixtureRunning,
  DEFAULT_FIXTURE,
} from './helpers/docker-fixture';
import { sshExec, waitForSSH } from './helpers/ssh-helpers';

const { host, port, user, keyPath } = DEFAULT_FIXTURE;

test.describe('Docker SSH fixture smoke tests', () => {
  // Ensure the fixture is running before any test runs.
  // If it's already running (e.g., started externally), skip the start.
  let weStartedFixture = false;

  test.beforeAll(async () => {
    const running = await isFixtureRunning();
    if (!running) {
      await startFixture();
      weStartedFixture = true;
    }
    // Wait for SSH to be reachable regardless of who started it.
    await waitForSSH(host, port, user, keyPath, 60_000);
  });

  test.afterAll(async () => {
    if (weStartedFixture) {
      await stopFixture();
    }
  });

  test('Docker fixture starts and SSH is reachable', async () => {
    const result = await sshExec(host, port, user, keyPath, 'whoami');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('testuser');
  });

  test('tmux is available in fixture', async () => {
    const result = await sshExec(host, port, user, keyPath, 'tmux -V');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^tmux \d+/);
  });

  test('pocketshell stub responds', async () => {
    const result = await sshExec(host, port, user, keyPath, 'pocketshell --version');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
