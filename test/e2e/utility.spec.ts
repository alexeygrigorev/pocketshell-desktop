import { test, expect } from '@playwright/test';
import {
  startFixture,
  stopFixture,
  isFixtureRunning,
  DEFAULT_FIXTURE,
} from './helpers/docker-fixture';
import { sshExec, waitForSSH } from './helpers/ssh-helpers';

const { host, port, user, keyPath } = DEFAULT_FIXTURE;

test.describe('PocketShell utility E2E tests', () => {
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

  test('pocketshell --version returns valid version', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell --version',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('pocketshell usage returns structured output', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell usage',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);

    // Output is NDJSON — each line should be valid JSON
    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('engine');
      expect(parsed).toHaveProperty('model');
      expect(parsed).toHaveProperty('in');
      expect(parsed).toHaveProperty('out');
      expect(parsed).toHaveProperty('cost_usd');
    }
  });

  test('pocketshell usage --json returns same NDJSON output', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell usage --json',
    );
    expect(result.exitCode).toBe(0);

    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('engine');
      expect(parsed).toHaveProperty('cost_usd');
    }
  });

  test('pocketshell sessions list returns session data', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell sessions list',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('claude-main');
    expect(result.stdout).toContain('codex');
    expect(result.stdout).toContain('opencode-lab');
  });

  test('pocketshell sessions attach by name works', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell sessions claude-main',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('Attached to session claude-main');
  });

  test('pocketshell sessions attach by index works', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell sessions 1',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('Attached to session claude-main');
  });

  test('pocketshell sessions create with : prefix', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell sessions :my-new-session',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('Created and attached to session :my-new-session');
  });

  test('pocketshell jobs list returns data', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell jobs list',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('fix-auth-bug');
    expect(result.stdout).toContain('add-tests');
    expect(result.stdout).toContain('refactor-api');
  });

  test('pocketshell jobs add creates a new job', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell jobs add',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('Created job 4');
  });

  test('pocketshell jobs edit updates a job', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell jobs edit 2',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('Updated job 2');
  });

  test('pocketshell jobs remove deletes a job', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell jobs remove 3',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('Removed job 3');
  });

  test('pocketshell env list returns environment info', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell env list',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('API_KEY=');
    expect(result.stdout).toContain('DATABASE_URL=');
  });

  test('pocketshell logs tail returns log output', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell logs tail',
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toHaveProperty('ts');
    expect(parsed).toHaveProperty('kind');
    expect(parsed).toHaveProperty('msg');
  });

  test('pocketshell logs path returns log file path', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell logs path',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/pocketshell\/logs\/.*\.jsonl$/);
  });

  test('pocketshell hooks list returns hooks status', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell hooks status',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('claude');
    expect(result.stdout).toContain('installed');
  });

  test('pocketshell hooks install confirms installation', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell hooks install',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Hooks installed');
  });

  test('pocketshell hooks uninstall confirms removal', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell hooks uninstall',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Hooks removed');
  });

  test('pocketshell hooks events returns event data', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell hooks events',
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toHaveProperty('ts');
    expect(parsed).toHaveProperty('engine');
    expect(parsed).toHaveProperty('state');
  });

  test('pocketshell repos list returns repository paths', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell repos list',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('/home/testuser/git/pocketshell');
    expect(result.stdout).toContain('/home/testuser/git/test-project');
  });
});
