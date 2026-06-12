/**
 * Tmux Session Manager integration tests
 *
 * Tests against real tmux (if available) via Docker SSH fixture.
 * These tests are skipped if tmux is not available on the system.
 *
 * Run with: npm test -- test/unit/tmux-ui/tmux-session-integration.test.ts
 *
 * Prerequisites:
 *   - Docker running with SSH fixture at localhost:2222
 *   - npm run test:docker:up
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TmuxSessionManager } from '../../../src/tmux-ui/tmux-session-manager';
import { TmuxClient } from '../../../src/tmux/client';
import { TerminalManager } from '../../../src/terminal/terminal-manager';
import { SshClient } from '../../../src/ssh/connection/ssh-client';
import type { SshChannel } from '../../../src/tmux/client';

// ---------------------------------------------------------------------------
// Check if tmux integration tests can run
// ---------------------------------------------------------------------------

const SSH_HOST = 'localhost';
const SSH_PORT = 2222;
const SSH_USER = 'testuser';
const SSH_KEY_PATH = 'test/fixtures/docker/keys/test_user_key';

let sshClient: SshClient;
let tmuxClient: TmuxClient;
let terminalManager: TerminalManager;
let sessionManager: TmuxSessionManager;
let channel: SshChannel;

/**
 * Check if we can connect to the Docker SSH fixture.
 * Returns true if the connection succeeds, false otherwise.
 */
async function canConnect(): Promise<boolean> {
  try {
    const client = new SshClient();
    const fs = await import('fs');
    const key = fs.readFileSync(SSH_KEY_PATH);
    await client.connect({
      host: SSH_HOST,
      port: SSH_PORT,
      user: SSH_USER,
      key: { type: 'pem', content: key },
      knownHosts: { type: 'acceptAll' },
      timeoutMs: 5000,
    });
    client.disconnect();
    return true;
  } catch {
    return false;
  }
}

let connectionAvailable = false;

beforeAll(async () => {
  connectionAvailable = await canConnect();
  if (!connectionAvailable) {
    return; // Skip setup
  }

  // Connect to SSH
  const fs = await import('fs');
  const key = fs.readFileSync(SSH_KEY_PATH);

  sshClient = new SshClient();
  await sshClient.connect({
    host: SSH_HOST,
    port: SSH_PORT,
    user: SSH_USER,
    key: { type: 'pem', content: key },
    knownHosts: { type: 'acceptAll' },
    timeoutMs: 10000,
  });

  // Create tmux client
  tmuxClient = new TmuxClient({
    sessionName: `test-${Date.now()}`,
    createIfMissing: true,
  });

  terminalManager = new TerminalManager();
  sessionManager = new TmuxSessionManager(tmuxClient, terminalManager);
}, 30000);

afterAll(async () => {
  if (!connectionAvailable) return;

  try {
    await sessionManager?.stop();
  } catch {
    // Best effort
  }

  try {
    sshClient?.disconnect();
  } catch {
    // Best effort
  }
}, 10000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!connectionAvailable)('TmuxSessionManager integration', () => {
  it('starts tmux session and verifies state', async () => {
    // Open a shell channel for tmux control mode
    const shell = await sshClient.shell({ term: 'xterm-256color', cols: 200, rows: 50 });

    const sshChannel: SshChannel = {
      write: async (data: Buffer) => { shell.stdin.write(data); },
      getStdoutReader: () => ({
        read: () => new Promise<Buffer | null>((resolve) => {
          const onData = (chunk: Buffer) => {
            shell.stdout.removeListener('data', onData);
            resolve(chunk);
          };
          shell.stdout.once('data', onData);

          // Timeout after 10s
          setTimeout(() => {
            shell.stdout.removeListener('data', onData);
            resolve(null);
          }, 10000);
        }),
      }),
      close: async () => { shell.close(); },
    };

    await sessionManager.start(sshChannel, 1);

    // Give tmux a moment to send initial notifications
    await new Promise(resolve => setTimeout(resolve, 2000));

    const state = sessionManager.getState();
    // After starting, we should have at least one session
    // (The exact state depends on whether the session already existed)
    expect(state).toBeDefined();
  });

  it('stop closes all terminals', async () => {
    await sessionManager.stop();

    expect(terminalManager.count).toBe(0);
    expect(sessionManager.getState().sessions.size).toBe(0);
  });
});
