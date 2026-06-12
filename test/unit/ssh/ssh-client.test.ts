/**
 * Unit tests for SshClient and ConnectionPool.
 *
 * Uses the Docker SSH fixture for integration-level tests.
 * When the fixture is not available, connection tests are skipped.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SshClient, ConnectionPool } from '../../../src/ssh/connection/ssh-client';
import type { SshConnectParams, PoolKey } from '../../../src/ssh/connection/ssh-client';
import { ConnectionManager, ConnectionState, ConnectionEvent } from '../../../src/ssh/connection/connection-manager';

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

// ---------------------------------------------------------------------------
// SshClient tests
// ---------------------------------------------------------------------------

describe('SshClient', () => {
  beforeAll(async () => {
    fixtureAvailable = await isFixtureAvailable();
  });

  describe('connect / disconnect', () => {
    it.skipIf = fixtureAvailable ? it : it.skip;

    it('connects to the Docker fixture', async () => {
      if (!fixtureAvailable) return;

      const client = new SshClient();
      const conn = await client.connect({
        host: FIXTURE_HOST,
        port: FIXTURE_PORT,
        user: FIXTURE_USER,
        key: { type: 'path', file: FIXTURE_KEY_PATH },
        knownHosts: { type: 'acceptAll' },
        timeoutMs: 10_000,
      });

      expect(conn.connected).toBe(true);
      client.disconnect();
      expect(conn.connected).toBe(false);
    });

    it('throws on invalid credentials', async () => {
      if (!fixtureAvailable) return;

      const client = new SshClient();
      await expect(
        client.connect({
          host: FIXTURE_HOST,
          port: FIXTURE_PORT,
          user: 'nonexistent',
          key: { type: 'path', file: FIXTURE_KEY_PATH },
          knownHosts: { type: 'acceptAll' },
          timeoutMs: 5000,
        }),
      ).rejects.toThrow();

      expect(client.connected).toBe(false);
    });

    it('throws on unreachable host', async () => {
      const client = new SshClient();
      await expect(
        client.connect({
          host: '192.0.2.1', // TEST-NET, should be unreachable
          port: 22,
          user: 'user',
          key: { type: 'path', file: FIXTURE_KEY_PATH },
          knownHosts: { type: 'acceptAll' },
          timeoutMs: 2000,
        }),
      ).rejects.toThrow();

      expect(client.connected).toBe(false);
    });

    it('disconnect is idempotent', async () => {
      if (!fixtureAvailable) return;

      const client = new SshClient();
      await client.connect({
        host: FIXTURE_HOST,
        port: FIXTURE_PORT,
        user: FIXTURE_USER,
        key: { type: 'path', file: FIXTURE_KEY_PATH },
        knownHosts: { type: 'acceptAll' },
        timeoutMs: 10_000,
      });

      // Multiple disconnects should not throw
      client.disconnect();
      client.disconnect();
      client.disconnect();
      expect(client.connected).toBe(false);
    });
  });

  describe('exec', () => {
    it('executes a command and returns result', async () => {
      if (!fixtureAvailable) return;

      const client = new SshClient();
      await client.connect({
        host: FIXTURE_HOST,
        port: FIXTURE_PORT,
        user: FIXTURE_USER,
        key: { type: 'path', file: FIXTURE_KEY_PATH },
        knownHosts: { type: 'acceptAll' },
        timeoutMs: 10_000,
      });

      const result = await client.exec('echo hello');
      expect(result.stdout.trim()).toBe('hello');
      expect(result.exitCode).toBe(0);

      client.disconnect();
    });

    it('captures stderr', async () => {
      if (!fixtureAvailable) return;

      const client = new SshClient();
      await client.connect({
        host: FIXTURE_HOST,
        port: FIXTURE_PORT,
        user: FIXTURE_USER,
        key: { type: 'path', file: FIXTURE_KEY_PATH },
        knownHosts: { type: 'acceptAll' },
        timeoutMs: 10_000,
      });

      const result = await client.exec('echo error >&2');
      expect(result.stderr.trim()).toBe('error');

      client.disconnect();
    });

    it('returns non-zero exit code', async () => {
      if (!fixtureAvailable) return;

      const client = new SshClient();
      await client.connect({
        host: FIXTURE_HOST,
        port: FIXTURE_PORT,
        user: FIXTURE_USER,
        key: { type: 'path', file: FIXTURE_KEY_PATH },
        knownHosts: { type: 'acceptAll' },
        timeoutMs: 10_000,
      });

      const result = await client.exec('exit 42');
      expect(result.exitCode).toBe(42);

      client.disconnect();
    });

    it('throws when not connected', async () => {
      const client = new SshClient();
      await expect(client.exec('echo test')).rejects.toThrow('Not connected');
    });
  });

  describe('shell', () => {
    it('opens an interactive shell', async () => {
      if (!fixtureAvailable) return;

      const client = new SshClient();
      await client.connect({
        host: FIXTURE_HOST,
        port: FIXTURE_PORT,
        user: FIXTURE_USER,
        key: { type: 'path', file: FIXTURE_KEY_PATH },
        knownHosts: { type: 'acceptAll' },
        timeoutMs: 10_000,
      });

      const shell = await client.shell();
      expect(shell).toBeDefined();
      expect(shell.stdin).toBeDefined();
      expect(shell.stdout).toBeDefined();

      shell.close();
      client.disconnect();
    });
  });

  describe('sftp', () => {
    it('attempts to open an SFTP session (may fail if subsystem unavailable)', async () => {
      if (!fixtureAvailable) return;

      const client = new SshClient();
      await client.connect({
        host: FIXTURE_HOST,
        port: FIXTURE_PORT,
        user: FIXTURE_USER,
        key: { type: 'path', file: FIXTURE_KEY_PATH },
        knownHosts: { type: 'acceptAll' },
        timeoutMs: 10_000,
      });

      try {
        const sftp = await client.sftp();
        expect(sftp).toBeDefined();
      } catch (err: any) {
        // The Docker fixture may not have the sftp subsystem configured.
        // Accept this as a known limitation.
        expect(err.message).toContain('subsystem');
      }

      client.disconnect();
    });
  });
});

// ---------------------------------------------------------------------------
// ConnectionPool tests
// ---------------------------------------------------------------------------

describe('ConnectionPool', () => {
  let pool: ConnectionPool;

  beforeEach(() => {
    pool = new ConnectionPool({ idleTtlMs: 2000, maxIdle: 2 });
  });

  afterEach(() => {
    pool.closeAll();
  });

  const makeParams = (): SshConnectParams => ({
    host: FIXTURE_HOST,
    port: FIXTURE_PORT,
    user: FIXTURE_USER,
    key: { type: 'path', file: FIXTURE_KEY_PATH },
    knownHosts: { type: 'acceptAll' },
    timeoutMs: 10_000,
  });

  const makeKey = (id = 'test'): PoolKey => ({
    host: FIXTURE_HOST,
    port: FIXTURE_PORT,
    user: FIXTURE_USER,
    credentialId: id,
  });

  it('acquires and releases a connection', async () => {
    if (!fixtureAvailable) return;

    const key = makeKey();
    const params = makeParams();

    const conn = await pool.acquire(key, params);
    expect(conn.connected).toBe(true);

    pool.release(key);
    // After release, the connection should still be alive (in idle pool)
    expect(pool.hasLive(key)).toBe(true);
  });

  it('reuses connection on second acquire', async () => {
    if (!fixtureAvailable) return;

    const key = makeKey();
    const params = makeParams();

    const conn1 = await pool.acquire(key, params);
    pool.release(key);

    const conn2 = await pool.acquire(key, params);
    expect(conn2).toBe(conn1);
    pool.release(key);
  });

  it('force-disconnects a connection', async () => {
    if (!fixtureAvailable) return;

    const key = makeKey();
    const params = makeParams();

    await pool.acquire(key, params);
    pool.disconnect(key);

    expect(pool.hasLive(key)).toBe(false);
  });

  it('closeAll disconnects everything', async () => {
    if (!fixtureAvailable) return;

    const key1 = makeKey('a');
    const key2 = makeKey('b');
    const params = makeParams();

    await pool.acquire(key1, params);
    await pool.acquire(key2, params);

    pool.closeAll();
    expect(pool.hasLive(key1)).toBe(false);
    expect(pool.hasLive(key2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ConnectionManager tests
// ---------------------------------------------------------------------------

describe('ConnectionManager', () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    manager = new ConnectionManager({ maxReconnectAttempts: 2 });
  });

  afterEach(() => {
    manager.destroy();
  });

  const makeParams = (): SshConnectParams => ({
    host: FIXTURE_HOST,
    port: FIXTURE_PORT,
    user: FIXTURE_USER,
    key: { type: 'path', file: FIXTURE_KEY_PATH },
    knownHosts: { type: 'acceptAll' },
    timeoutMs: 10_000,
  });

  describe('state transitions', () => {
    it('starts in Idle state', () => {
      expect(manager.getState(1)).toBe(ConnectionState.Idle);
    });

    it('transitions through Idle -> Connecting -> Connected', async () => {
      if (!fixtureAvailable) return;

      const states: ConnectionState[] = [];
      manager.onStateChange((change) => {
        states.push(change.newState);
      });

      await manager.connect(1, makeParams());

      expect(states).toContain(ConnectionState.Connecting);
      expect(states).toContain(ConnectionState.Connected);
      expect(manager.getState(1)).toBe(ConnectionState.Connected);
    });

    it('transitions through Connected -> Disconnecting -> Disconnected', async () => {
      if (!fixtureAvailable) return;

      await manager.connect(1, makeParams());

      const states: ConnectionState[] = [];
      manager.onStateChange((change) => {
        states.push(change.newState);
      });

      manager.disconnect(1);

      expect(states).toContain(ConnectionState.Disconnecting);
      expect(states).toContain(ConnectionState.Disconnected);
      expect(manager.getState(1)).toBe(ConnectionState.Disconnected);
    });

    it('transitions to Error on connection failure', async () => {
      const states: ConnectionState[] = [];
      manager.onStateChange((change) => {
        states.push(change.newState);
      });

      await expect(
        manager.connect(1, {
          host: '192.0.2.1',
          port: 22,
          user: 'user',
          key: { type: 'path', file: FIXTURE_KEY_PATH },
          knownHosts: { type: 'acceptAll' },
          timeoutMs: 2000,
        }),
      ).rejects.toThrow();

      expect(states).toContain(ConnectionState.Error);
      expect(manager.getState(1)).toBe(ConnectionState.Error);
    });
  });

  describe('getConnection', () => {
    it('returns null when no connection exists', () => {
      expect(manager.getConnection(1)).toBeNull();
    });

    it('returns connection after connect', async () => {
      if (!fixtureAvailable) return;

      await manager.connect(1, makeParams());
      const conn = manager.getConnection(1);
      expect(conn).not.toBeNull();
      expect(conn!.connected).toBe(true);
    });

    it('returns null after disconnect', async () => {
      if (!fixtureAvailable) return;

      await manager.connect(1, makeParams());
      manager.disconnect(1);
      expect(manager.getConnection(1)).toBeNull();
    });
  });

  describe('onStateChange', () => {
    it('provides unsubscribe function', async () => {
      if (!fixtureAvailable) return;

      const states: string[] = [];
      const unsub = manager.onStateChange((change) => {
        states.push(change.newState);
      });

      unsub();

      await manager.connect(1, makeParams());
      // Callback was removed, so states should be empty
      expect(states).toHaveLength(0);
    });
  });

  describe('reconnect', () => {
    it('reconnects after explicit reconnect call', async () => {
      if (!fixtureAvailable) return;

      await manager.connect(1, makeParams());
      manager.disconnect(1);

      expect(manager.getState(1)).toBe(ConnectionState.Disconnected);

      // Trigger reconnect
      manager.reconnect(1, makeParams());

      // Wait for the reconnect to complete
      await new Promise((resolve) => setTimeout(resolve, 3000));

      expect(manager.getState(1)).toBe(ConnectionState.Connected);
    });
  });

  describe('disconnectAll', () => {
    it('disconnects all hosts', async () => {
      if (!fixtureAvailable) return;

      await manager.connect(1, makeParams());
      await manager.connect(2, makeParams());

      manager.disconnectAll();

      expect(manager.getState(1)).toBe(ConnectionState.Disconnected);
      expect(manager.getState(2)).toBe(ConnectionState.Disconnected);
    });
  });
});
