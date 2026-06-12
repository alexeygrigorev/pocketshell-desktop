/**
 * Unit tests for HostStore.
 *
 * Uses in-memory SQLite so no file system artifacts are left behind.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { HostStore } from '../../../src/ssh/data/host-store';
import { KeyStore } from '../../../src/ssh/data/key-store';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('HostStore', () => {
  let db: Database.Database;
  let hostStore: HostStore;
  let keyStore: KeyStore;

  beforeEach(() => {
    db = createTestDb();
    // Initialize key store first (hosts table references ssh_keys)
    keyStore = new KeyStore(db, '/tmp/test-keys');
    hostStore = new HostStore(db);
  });

  describe('empty store', () => {
    it('returns empty array when no hosts exist', () => {
      expect(hostStore.list()).toEqual([]);
    });

    it('returns undefined for non-existent host', () => {
      expect(hostStore.get(999)).toBeUndefined();
    });
  });

  describe('add', () => {
    it('inserts a host and returns an id', () => {
      // Create a key first
      const keyId = insertTestKey(db);

      const id = hostStore.add({
        name: 'My Server',
        hostname: '192.168.1.100',
        port: 22,
        username: 'admin',
        keyId,
        maxAutoPort: 10000,
        skipPortsBelow: 1000,
        scanIntervalSec: 5,
        enabled: false,
      });

      expect(id).toBeGreaterThan(0);
    });

    it('stores all fields correctly', () => {
      const keyId = insertTestKey(db);

      const id = hostStore.add({
        name: 'Test Host',
        hostname: 'example.com',
        port: 2222,
        username: 'testuser',
        keyId,
        maxAutoPort: 20000,
        skipPortsBelow: 500,
        scanIntervalSec: 10,
        enabled: true,
      });

      const host = hostStore.get(id)!;
      expect(host).toBeDefined();
      expect(host.name).toBe('Test Host');
      expect(host.hostname).toBe('example.com');
      expect(host.port).toBe(2222);
      expect(host.username).toBe('testuser');
      expect(host.keyId).toBe(keyId);
      expect(host.maxAutoPort).toBe(20000);
      expect(host.skipPortsBelow).toBe(500);
      expect(host.scanIntervalSec).toBe(10);
      expect(host.enabled).toBe(true);
      expect(host.createdAt).toBeGreaterThan(0);
      expect(host.lastConnectedAt).toBeNull();
    });

    it('defaults nullable fields to null', () => {
      const keyId = insertTestKey(db);

      const id = hostStore.add({
        name: 'Defaults',
        hostname: 'host',
        port: 22,
        username: 'user',
        keyId,
        maxAutoPort: 10000,
        skipPortsBelow: 1000,
        scanIntervalSec: 5,
        enabled: false,
      });

      const host = hostStore.get(id)!;
      expect(host.tmuxInstalled).toBeNull();
      expect(host.lastBootstrapAt).toBeNull();
      expect(host.pocketshellInstalled).toBeNull();
      expect(host.pocketshellCliVersion).toBeNull();
      expect(host.claudeProfilesJson).toBeNull();
      expect(host.codexProfilesJson).toBeNull();
    });
  });

  describe('list', () => {
    it('returns hosts ordered by name', () => {
      const keyId = insertTestKey(db);

      hostStore.add({
        name: 'Zebra',
        hostname: 'z.example.com',
        port: 22,
        username: 'user',
        keyId,
        maxAutoPort: 10000,
        skipPortsBelow: 1000,
        scanIntervalSec: 5,
        enabled: true,
      });

      hostStore.add({
        name: 'Alpha',
        hostname: 'a.example.com',
        port: 22,
        username: 'user',
        keyId,
        maxAutoPort: 10000,
        skipPortsBelow: 1000,
        scanIntervalSec: 5,
        enabled: false,
      });

      const hosts = hostStore.list();
      expect(hosts).toHaveLength(2);
      expect(hosts[0].name).toBe('Alpha');
      expect(hosts[1].name).toBe('Zebra');
    });
  });

  describe('listEnabled', () => {
    it('returns only enabled hosts', () => {
      const keyId = insertTestKey(db);

      hostStore.add({
        name: 'Enabled',
        hostname: 'e.example.com',
        port: 22,
        username: 'user',
        keyId,
        maxAutoPort: 10000,
        skipPortsBelow: 1000,
        scanIntervalSec: 5,
        enabled: true,
      });

      hostStore.add({
        name: 'Disabled',
        hostname: 'd.example.com',
        port: 22,
        username: 'user',
        keyId,
        maxAutoPort: 10000,
        skipPortsBelow: 1000,
        scanIntervalSec: 5,
        enabled: false,
      });

      const enabled = hostStore.listEnabled();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('Enabled');
    });
  });

  describe('get', () => {
    it('returns host by id', () => {
      const keyId = insertTestKey(db);

      const id = hostStore.add({
        name: 'Fetch Me',
        hostname: 'fetch.example.com',
        port: 22,
        username: 'user',
        keyId,
        maxAutoPort: 10000,
        skipPortsBelow: 1000,
        scanIntervalSec: 5,
        enabled: false,
      });

      const host = hostStore.get(id);
      expect(host).toBeDefined();
      expect(host!.name).toBe('Fetch Me');
    });
  });

  describe('update', () => {
    it('updates an existing host', () => {
      const keyId = insertTestKey(db);

      const id = hostStore.add({
        name: 'Before',
        hostname: 'before.example.com',
        port: 22,
        username: 'user',
        keyId,
        maxAutoPort: 10000,
        skipPortsBelow: 1000,
        scanIntervalSec: 5,
        enabled: false,
      });

      const host = hostStore.get(id)!;
      host.name = 'After';
      host.hostname = 'after.example.com';
      host.port = 2222;
      host.enabled = true;
      host.tmuxInstalled = true;
      host.pocketshellCliVersion = '1.2.3';

      const updated = hostStore.update(host);
      expect(updated).toBe(true);

      const refreshed = hostStore.get(id)!;
      expect(refreshed.name).toBe('After');
      expect(refreshed.hostname).toBe('after.example.com');
      expect(refreshed.port).toBe(2222);
      expect(refreshed.enabled).toBe(true);
      expect(refreshed.tmuxInstalled).toBe(true);
      expect(refreshed.pocketshellCliVersion).toBe('1.2.3');
    });

    it('returns false for non-existent host', () => {
      const result = hostStore.update({
        id: 999,
        name: 'Ghost',
        hostname: 'ghost.example.com',
        port: 22,
        username: 'user',
        keyId: 1,
        maxAutoPort: 10000,
        skipPortsBelow: 1000,
        scanIntervalSec: 5,
        enabled: false,
        createdAt: Date.now(),
        lastConnectedAt: null,
        tmuxInstalled: null,
        lastBootstrapAt: null,
        pocketshellInstalled: null,
        pocketshellLastDetectedAt: null,
        pocketshellCliVersion: null,
        pocketshellExpectedCliVersion: null,
        pocketshellVersionCompatible: null,
        pocketshellDaemonRunning: null,
        pocketshellDaemonEnabled: null,
        usageCommandOverride: null,
        claudeProfilesJson: null,
        codexProfilesJson: null,
      });
      expect(result).toBe(false);
    });
  });

  describe('delete', () => {
    it('deletes a host by id', () => {
      const keyId = insertTestKey(db);

      const id = hostStore.add({
        name: 'Delete Me',
        hostname: 'del.example.com',
        port: 22,
        username: 'user',
        keyId,
        maxAutoPort: 10000,
        skipPortsBelow: 1000,
        scanIntervalSec: 5,
        enabled: false,
      });

      expect(hostStore.delete(id)).toBe(true);
      expect(hostStore.get(id)).toBeUndefined();
    });

    it('returns false for non-existent id', () => {
      expect(hostStore.delete(999)).toBe(false);
    });
  });

  describe('touchConnected', () => {
    it('updates lastConnectedAt timestamp', () => {
      const keyId = insertTestKey(db);

      const id = hostStore.add({
        name: 'Touch',
        hostname: 'touch.example.com',
        port: 22,
        username: 'user',
        keyId,
        maxAutoPort: 10000,
        skipPortsBelow: 1000,
        scanIntervalSec: 5,
        enabled: false,
      });

      const before = hostStore.get(id)!.lastConnectedAt;
      expect(before).toBeNull();

      hostStore.touchConnected(id);

      const after = hostStore.get(id)!.lastConnectedAt;
      expect(after).not.toBeNull();
      expect(after!).toBeGreaterThan(0);
    });
  });

  describe('CRUD cycle', () => {
    it('full create-read-update-delete cycle', () => {
      const keyId = insertTestKey(db);

      // Create
      const id = hostStore.add({
        name: 'Cycle',
        hostname: 'cycle.example.com',
        port: 22,
        username: 'user',
        keyId,
        maxAutoPort: 10000,
        skipPortsBelow: 1000,
        scanIntervalSec: 5,
        enabled: false,
      });

      // Read
      let host = hostStore.get(id);
      expect(host).toBeDefined();
      expect(host!.name).toBe('Cycle');

      // Update
      host!.name = 'Cycle Updated';
      hostStore.update(host!);
      host = hostStore.get(id);
      expect(host!.name).toBe('Cycle Updated');

      // Delete
      hostStore.delete(id);
      expect(hostStore.get(id)).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Helper: insert a test SSH key to satisfy FK constraints
// ---------------------------------------------------------------------------

function insertTestKey(db: Database.Database): number {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO ssh_keys (name, private_key_path, fingerprint, has_passphrase, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('test-key', '/tmp/test-key', 'sha256:abc123', 0, now);
  return Number(result.lastInsertRowid);
}
