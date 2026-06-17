/**
 * Unit tests for HostMetadataStore.
 *
 * Uses in-memory sql.js. Verifies that the store holds ONLY PocketShell
 * metadata keyed by stable identity (never connection details).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import {
  HostMetadataStore,
  type HostMetadata,
} from '../../../src/ssh/data/host-metadata-store';

async function createTestDb(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();
  return new SQL.Database();
}

function sampleMetadata(identity: string, alias: string): HostMetadata {
  return {
    identity,
    alias,
    maxAutoPort: 10000,
    skipPortsBelow: 1000,
    scanIntervalSec: 5,
    enabled: true,
    createdAt: 0,
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
  };
}

describe('HostMetadataStore', () => {
  let store: HostMetadataStore;

  beforeEach(async () => {
    store = new HostMetadataStore(await createTestDb(), ':memory:');
  });

  it('starts empty', () => {
    expect(store.list()).toEqual([]);
    expect(store.get('alias:missing')).toBeUndefined();
  });

  it('upserts a new row with defaults and reads it back by identity', () => {
    const m = store.upsert('alias:prod', 'prod', { enabled: false });
    expect(m.identity).toBe('alias:prod');
    expect(m.alias).toBe('prod');
    expect(m.enabled).toBe(false);
    expect(m.maxAutoPort).toBe(10000);

    const got = store.get('alias:prod');
    expect(got?.alias).toBe('prod');
  });

  it('patches existing rows without losing un-supplied fields', () => {
    store.upsert('alias:prod', 'prod', { pocketshellCliVersion: '1.0.0', enabled: false });
    store.upsert('alias:prod', 'prod', { tmuxInstalled: true });

    const m = store.get('alias:prod');
    expect(m?.pocketshellCliVersion).toBe('1.0.0'); // preserved
    expect(m?.enabled).toBe(false); // preserved
    expect(m?.tmuxInstalled).toBe(true); // updated
  });

  it('asMap keys all rows by identity', () => {
    store.upsert('alias:a', 'a');
    store.upsert('alias:b', 'b');
    const map = store.asMap();
    expect(map.size).toBe(2);
    expect(map.has('alias:a')).toBe(true);
  });

  it('touchConnected sets lastConnectedAt', () => {
    store.upsert('alias:prod', 'prod');
    expect(store.get('alias:prod')?.lastConnectedAt).toBeNull();
    store.touchConnected('alias:prod');
    expect(store.get('alias:prod')?.lastConnectedAt).toBeGreaterThan(0);
  });

  it('delete removes a row and reports false when absent', () => {
    store.upsert('alias:prod', 'prod');
    expect(store.delete('alias:prod')).toBe(true);
    expect(store.delete('alias:prod')).toBe(false);
  });

  it('round-trips every metadata field', () => {
    const full: HostMetadata = {
      ...sampleMetadata('alias:full', 'full'),
      maxAutoPort: 12345,
      skipPortsBelow: 100,
      scanIntervalSec: 7,
      enabled: false,
      createdAt: 111,
      lastConnectedAt: 222,
      tmuxInstalled: true,
      lastBootstrapAt: 333,
      pocketshellInstalled: false,
      pocketshellLastDetectedAt: 444,
      pocketshellCliVersion: '2.0.1',
      pocketshellExpectedCliVersion: '2.0.0',
      pocketshellVersionCompatible: true,
      pocketshellDaemonRunning: false,
      pocketshellDaemonEnabled: true,
      usageCommandOverride: 'custom-cmd',
      claudeProfilesJson: '{"default":{}}',
      codexProfilesJson: '{"codex":{}}',
    };
    store.upsert(full.identity, full.alias, full);
    const got = store.get(full.identity);
    expect(got).toEqual(full);
  });

  it('never stores hostname/port/user/keyPath', () => {
    store.upsert('alias:prod', 'prod');
    const all = store.list();
    // Metadata must not carry connection details.
    expect(all).not.toContainEqual(expect.objectContaining({ hostname: expect.anything() }));
    const cols = (store as unknown as { db: SqlJsDatabase }).db.exec(
      'PRAGMA table_info(host_metadata)',
    );
    const names: string[] = cols.length ? cols[0].values.map(r => String(r[1])) : [];
    for (const forbidden of ['hostname', 'port', 'username', 'key_path', 'keyPath']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('HostMetadataStore: migration "seen" set', () => {
  let store: HostMetadataStore;

  beforeEach(async () => {
    store = new HostMetadataStore(await createTestDb(), ':memory:');
  });

  it('marks a key seen once and reports it as already seen afterwards', () => {
    expect(store.isMigrationSeen('prod.example.com|22|deploy')).toBe(false);
    expect(store.markMigrationSeen('prod.example.com|22|deploy')).toBe(true);
    expect(store.isMigrationSeen('prod.example.com|22|deploy')).toBe(true);
    // Second mark is a no-op (returns false, key stays present).
    expect(store.markMigrationSeen('prod.example.com|22|deploy')).toBe(false);
    expect(store.isMigrationSeen('prod.example.com|22|deploy')).toBe(true);
  });

  it('keeps distinct keys independent', () => {
    store.markMigrationSeen('a|22|u');
    expect(store.isMigrationSeen('a|22|u')).toBe(true);
    expect(store.isMigrationSeen('b|22|u')).toBe(false);
  });

  it('clearMigrationSeen forgets all reported keys', () => {
    store.markMigrationSeen('a|22|u');
    store.markMigrationSeen('b|22|u');
    store.clearMigrationSeen();
    expect(store.isMigrationSeen('a|22|u')).toBe(false);
    expect(store.isMigrationSeen('b|22|u')).toBe(false);
  });
});
