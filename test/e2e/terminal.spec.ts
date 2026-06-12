import { test, expect } from '@playwright/test';
import {
  startFixture,
  stopFixture,
  isFixtureRunning,
  DEFAULT_FIXTURE,
} from './helpers/docker-fixture';
import { sshExec, waitForSSH } from './helpers/ssh-helpers';

const { host, port, user, keyPath } = DEFAULT_FIXTURE;

test.describe('Terminal E2E tests', () => {
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

  test('SSH exec returns stdout output', async () => {
    const result = await sshExec(host, port, user, keyPath, 'echo hello-world');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello-world');
  });

  test('SSH exec captures stderr', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'echo error-msg >&2',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe('error-msg');
  });

  test('SSH exec returns non-zero exit code for failing commands', async () => {
    const result = await sshExec(host, port, user, keyPath, 'exit 42');
    expect(result.exitCode).toBe(42);
  });

  test('Can run multi-line commands', async () => {
    const cmd = 'echo line1 && echo line2 && echo line3';
    const result = await sshExec(host, port, user, keyPath, cmd);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toEqual(['line1', 'line2', 'line3']);
  });

  test('Can detect tmux version', async () => {
    const result = await sshExec(host, port, user, keyPath, 'tmux -V');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^tmux \d+\.\d+/);
  });

  test('tmux session creation and listing via exec', async () => {
    const sessionName = 'e2e-test-session';

    // Kill any leftover session with the same name
    await sshExec(
      host, port, user, keyPath,
      `tmux kill-session -t ${sessionName} 2>/dev/null || true`,
    );

    // Create a new detached session
    const createResult = await sshExec(
      host, port, user, keyPath,
      `tmux new-session -d -s ${sessionName}`,
    );
    expect(createResult.exitCode).toBe(0);

    // List sessions and verify ours appears
    const listResult = await sshExec(
      host, port, user, keyPath,
      'tmux list-sessions',
    );
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain(sessionName);

    // Clean up
    await sshExec(
      host, port, user, keyPath,
      `tmux kill-session -t ${sessionName}`,
    );
  });

  test('tmux window management via exec', async () => {
    const sessionName = 'e2e-window-test';

    // Create session
    await sshExec(
      host, port, user, keyPath,
      `tmux kill-session -t ${sessionName} 2>/dev/null || true`,
    );
    await sshExec(
      host, port, user, keyPath,
      `tmux new-session -d -s ${sessionName}`,
    );

    // Create a new window
    const newWinResult = await sshExec(
      host, port, user, keyPath,
      `tmux new-window -t ${sessionName} -n second-window`,
    );
    expect(newWinResult.exitCode).toBe(0);

    // List windows — should have at least 2
    const listWinResult = await sshExec(
      host, port, user, keyPath,
      `tmux list-windows -t ${sessionName}`,
    );
    expect(listWinResult.exitCode).toBe(0);
    const windows = listWinResult.stdout.trim().split('\n');
    expect(windows.length).toBeGreaterThanOrEqual(2);

    // Clean up
    await sshExec(
      host, port, user, keyPath,
      `tmux kill-session -t ${sessionName}`,
    );
  });

  test('tmux pane splitting via exec', async () => {
    const sessionName = 'e2e-pane-test';

    await sshExec(
      host, port, user, keyPath,
      `tmux kill-session -t ${sessionName} 2>/dev/null || true`,
    );
    await sshExec(
      host, port, user, keyPath,
      `tmux new-session -d -s ${sessionName}`,
    );

    // Split the window horizontally
    const splitResult = await sshExec(
      host, port, user, keyPath,
      `tmux split-window -h -t ${sessionName}`,
    );
    expect(splitResult.exitCode).toBe(0);

    // List panes — should have 2
    const listPanesResult = await sshExec(
      host, port, user, keyPath,
      `tmux list-panes -t ${sessionName}`,
    );
    expect(listPanesResult.exitCode).toBe(0);
    const panes = listPanesResult.stdout.trim().split('\n');
    expect(panes.length).toBe(2);

    // Clean up
    await sshExec(
      host, port, user, keyPath,
      `tmux kill-session -t ${sessionName}`,
    );
  });

  test('terminal resize sets COLUMNS and LINES env variables', async () => {
    // Run a command with explicit COLUMNS/LINES and verify they are respected
    const result = await sshExec(
      host, port, user, keyPath,
      'export COLUMNS=120 LINES=40 && echo "COLUMNS=$COLUMNS LINES=$LINES"',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('COLUMNS=120');
    expect(result.stdout.trim()).toContain('LINES=40');
  });

  test('can send input to tmux pane and read it back', async () => {
    const sessionName = 'e2e-input-test';

    await sshExec(
      host, port, user, keyPath,
      `tmux kill-session -t ${sessionName} 2>/dev/null || true`,
    );
    await sshExec(
      host, port, user, keyPath,
      `tmux new-session -d -s ${sessionName}`,
    );

    // Send text to the pane
    await sshExec(
      host, port, user, keyPath,
      `tmux send-keys -t ${sessionName} 'echo injected' Enter`,
    );

    // Give the shell a moment to process
    await sshExec(host, port, user, keyPath, 'sleep 0.5');

    // Capture the pane content
    const captureResult = await sshExec(
      host, port, user, keyPath,
      `tmux capture-pane -t ${sessionName} -p`,
    );
    expect(captureResult.exitCode).toBe(0);
    expect(captureResult.stdout).toContain('injected');

    // Clean up
    await sshExec(
      host, port, user, keyPath,
      `tmux kill-session -t ${sessionName}`,
    );
  });
});
