import { test, expect } from '@playwright/test';
import {
  startFixture,
  stopFixture,
  isFixtureRunning,
  DEFAULT_FIXTURE,
} from './helpers/docker-fixture';
import { sshExec, waitForSSH } from './helpers/ssh-helpers';

const { host, port, user, keyPath } = DEFAULT_FIXTURE;

test.describe('Agent detection E2E tests', () => {
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

  test('Detect Claude Code by checking for claude binary', async () => {
    // Verify the claude binary is on PATH and executable
    const whichResult = await sshExec(
      host, port, user, keyPath,
      'which claude',
    );
    expect(whichResult.exitCode).toBe(0);
    expect(whichResult.stdout.trim()).toMatch(/\/claude$/);

    // Verify version output
    const versionResult = await sshExec(
      host, port, user, keyPath,
      'claude --version',
    );
    expect(versionResult.exitCode).toBe(0);
    expect(versionResult.stdout.trim()).toContain('Claude Code fixture');
    expect(versionResult.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });

  test('Detect Codex by checking for codex binary', async () => {
    const whichResult = await sshExec(
      host, port, user, keyPath,
      'which codex',
    );
    expect(whichResult.exitCode).toBe(0);
    expect(whichResult.stdout.trim()).toMatch(/\/codex$/);

    const versionResult = await sshExec(
      host, port, user, keyPath,
      'codex --version',
    );
    expect(versionResult.exitCode).toBe(0);
    expect(versionResult.stdout.trim()).toContain('Codex fixture');
    expect(versionResult.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });

  test('Detect OpenCode by checking for opencode binary', async () => {
    const whichResult = await sshExec(
      host, port, user, keyPath,
      'which opencode',
    );
    expect(whichResult.exitCode).toBe(0);
    expect(whichResult.stdout.trim()).toMatch(/\/opencode$/);

    const versionResult = await sshExec(
      host, port, user, keyPath,
      'opencode --version',
    );
    expect(versionResult.exitCode).toBe(0);
    expect(versionResult.stdout.trim()).toContain('OpenCode fixture');
    expect(versionResult.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });

  test('Parse agent session files from fixture', async () => {
    // Check Claude session JSONL is parseable
    const claudeResult = await sshExec(
      host, port, user, keyPath,
      'cat ~/.claude/projects/-workspace-pocketshell/pocketshell-claude.jsonl',
    );
    expect(claudeResult.exitCode).toBe(0);
    const claudeLines = claudeResult.stdout.trim().split('\n');
    expect(claudeLines.length).toBeGreaterThanOrEqual(1);

    // Check Codex session JSONL is parseable
    const codexResult = await sshExec(
      host, port, user, keyPath,
      'cat ~/.codex/sessions/2026/05/22/pocketshell-codex.jsonl',
    );
    expect(codexResult.exitCode).toBe(0);
    const codexLines = codexResult.stdout.trim().split('\n');
    expect(codexLines.length).toBeGreaterThanOrEqual(1);

    // Check OpenCode session JSONL is parseable
    const opencodeResult = await sshExec(
      host, port, user, keyPath,
      'cat ~/.local/share/opencode/pocketshell-rows.jsonl',
    );
    expect(opencodeResult.exitCode).toBe(0);
    const opencodeLines = opencodeResult.stdout.trim().split('\n');
    expect(opencodeLines.length).toBeGreaterThanOrEqual(1);

    // Verify all lines are valid JSON
    for (const line of claudeLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    for (const line of codexLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    for (const line of opencodeLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test('Parse agent detections PSV file', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'cat /opt/pocketshell-agent-fixtures/agent-detections.psv',
    );
    expect(result.exitCode).toBe(0);

    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2); // header + data rows

    // Header should have expected columns
    const header = lines[0];
    expect(header).toContain('engine');
    expect(header).toContain('session');
    expect(header).toContain('pane');
    expect(header).toContain('pid');
    expect(header).toContain('cwd');
    expect(header).toContain('detected_at');

    // Data rows should include all three engines
    const dataRows = lines.slice(1);
    const engines = dataRows.map((row) => row.split('|')[0]);
    expect(engines).toContain('claude');
    expect(engines).toContain('codex');
    expect(engines).toContain('opencode');
  });

  test('Check pocketshell agent status command', async () => {
    // pocketshell agent-log returns structured JSON with --json flag
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell agent-log --engine claude --session test --json',
    );
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toHaveProperty('count');
    expect(parsed).toHaveProperty('engine');
    expect(parsed).toHaveProperty('path');
    expect(parsed.engine).toBe('claude');
    expect(typeof parsed.count).toBe('number');
  });

  test('pocketshell agent-log returns raw JSONL without --json flag', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell agent-log --engine claude --session test',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);

    // Output should be JSONL — each line is valid JSON
    const lines = result.stdout.trim().split('\n');
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test('pocketshell agent launches agent binary in directory', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'pocketshell agent claude --dir /home/testuser/git/pocketshell --version',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('Claude Code fixture');
  });

  test('All three agent binaries report fixture versions', async () => {
    const agents = ['claude', 'codex', 'opencode'];

    for (const agent of agents) {
      const result = await sshExec(
        host, port, user, keyPath,
        `${agent} --version`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
    }
  });
});
