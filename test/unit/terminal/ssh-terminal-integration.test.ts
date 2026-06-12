/**
 * Integration tests for SSH terminal backend against Docker fixture.
 *
 * Tests real SSH shell interaction: writing commands, reading output,
 * resizing, and closing. Skipped when the Docker fixture is not available.
 *
 * Run with: npm test -- test/unit/terminal/ssh-terminal-integration.test.ts
 * Docker fixture: npm run test:docker:up
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { SshClient } from '../../../src/ssh/connection/ssh-client';
import { SshTerminalBackend } from '../../../src/terminal/ssh-terminal-backend';
import { TerminalManager, resetIdCounter } from '../../../src/terminal/terminal-manager';

const FIXTURE_HOST = 'localhost';
const FIXTURE_PORT = 2222;
const FIXTURE_USER = 'testuser';
const FIXTURE_KEY_PATH = path.resolve(
  __dirname,
  '../../fixtures/docker/test_key',
);

/** Check if the Docker SSH fixture is reachable. */
async function isFixtureAvailable(): Promise<boolean> {
  const client = new SshClient();
  try {
    await client.connect({
      host: FIXTURE_HOST,
      port: FIXTURE_PORT,
      user: FIXTURE_USER,
      key: { type: 'path', file: FIXTURE_KEY_PATH },
      knownHosts: { type: 'acceptAll' },
      timeoutMs: 5000,
    });
    client.disconnect();
    return true;
  } catch {
    return false;
  }
}

let fixtureAvailable = false;
let client: SshClient;

beforeAll(async () => {
  fixtureAvailable = await isFixtureAvailable();
  if (!fixtureAvailable) return;

  client = new SshClient();
  await client.connect({
    host: FIXTURE_HOST,
    port: FIXTURE_PORT,
    user: FIXTURE_USER,
    key: { type: 'path', file: FIXTURE_KEY_PATH },
    knownHosts: { type: 'acceptAll' },
    timeoutMs: 10_000,
  });
});

afterAll(() => {
  if (client?.connected) {
    client.disconnect();
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSH Terminal Integration', () => {
  it('connects to fixture and creates terminal', async () => {
    if (!fixtureAvailable) return;

    const backend = new SshTerminalBackend(client);
    await backend.start();

    expect(backend.isStarted).toBe(true);

    backend.kill();
  });

  it('writes echo hello and reads output', async () => {
    if (!fixtureAvailable) return;

    const backend = new SshTerminalBackend(client);
    await backend.start();

    const received: string[] = [];
    const sub = backend.onData((data) => {
      received.push(data);
    });

    // Write a command
    backend.write('echo hello\n');

    // Wait for output
    await new Promise((r) => setTimeout(r, 1000));

    sub.dispose();
    backend.kill();

    const combined = received.join('');
    expect(combined).toContain('hello');
  });

  it('writes ls -la and expects file listing', async () => {
    if (!fixtureAvailable) return;

    const backend = new SshTerminalBackend(client);
    await backend.start();

    const received: string[] = [];
    const sub = backend.onData((data) => {
      received.push(data);
    });

    backend.write('ls -la\n');

    await new Promise((r) => setTimeout(r, 1000));

    sub.dispose();
    backend.kill();

    const combined = received.join('');
    // A file listing should contain total, . and ..
    expect(combined).toContain('total');
  });

  it('resizes terminal without crash', async () => {
    if (!fixtureAvailable) return;

    const backend = new SshTerminalBackend(client, {
      cols: 80,
      rows: 24,
    });
    await backend.start();

    // Resize should not throw or crash
    backend.resize(120, 40);
    backend.resize(200, 50);
    backend.resize(80, 24);

    // Write something after resize to confirm the shell is still alive
    const received: string[] = [];
    const sub = backend.onData((data) => {
      received.push(data);
    });

    backend.write('echo post-resize\n');
    await new Promise((r) => setTimeout(r, 500));

    sub.dispose();
    backend.kill();

    const combined = received.join('');
    expect(combined).toContain('post-resize');
  });

  it('closes terminal and verifies exit', async () => {
    if (!fixtureAvailable) return;

    const backend = new SshTerminalBackend(client);
    await backend.start();

    let exitCode: number | null = null;
    backend.onExit((e) => {
      exitCode = e.exitCode;
    });

    backend.kill();

    expect(backend.isKilled).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('manages multiple terminals simultaneously', async () => {
    if (!fixtureAvailable) return;

    resetIdCounter();
    const manager = new TerminalManager();

    const t1 = await manager.createTerminal(1, client, { name: 'Term 1' });
    const t2 = await manager.createTerminal(1, client, { name: 'Term 2' });

    expect(manager.count).toBe(2);
    expect(t1.id).not.toBe(t2.id);

    // Write to both
    const received1: string[] = [];
    const received2: string[] = [];

    t1.backend.onData((data) => received1.push(data));
    t2.backend.onData((data) => received2.push(data));

    t1.backend.write('echo from-term-1\n');
    t2.backend.write('echo from-term-2\n');

    await new Promise((r) => setTimeout(r, 1000));

    expect(received1.join('')).toContain('from-term-1');
    expect(received2.join('')).toContain('from-term-2');

    manager.closeAll();
    expect(manager.count).toBe(0);
  });
});
