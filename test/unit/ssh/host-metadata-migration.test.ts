/**
 * Unit tests for legacy -> metadata migration.
 *
 * Verifies that PocketShell-specific data survives the move to the
 * config-as-source-of-truth model when a legacy row matches an SSH config
 * entry, and is reported (not silently dropped) when it does not.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import { HostMetadataStore } from '../../../src/ssh/data/host-metadata-store';
import { migrateLegacyHosts, buildConnectionToAliasMap } from '../../../src/ssh/data/host-metadata-migration';
import { hostIdentityForAlias } from '../../../src/ssh/data/ssh-host-resolver';
import { parseSshConfigString } from '../../../src/ssh/data/ssh-config-parser';
import type { Host } from '../../../src/ssh/data/host-store';

async function createTestDb(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();
  return new SQL.Database();
}

function legacyHost(over: Partial<Host> = {}): Host {
  return {
    id: 1,
    name: 'prod',
    hostname: 'prod.example.com',
    port: 22,
    username: 'deploy',
    keyPath: '~/.ssh/id_rsa',
    maxAutoPort: 10000,
    skipPortsBelow: 1000,
    scanIntervalSec: 5,
    enabled: true,
    createdAt: 100,
    lastConnectedAt: 200,
    tmuxInstalled: true,
    lastBootstrapAt: null,
    pocketshellInstalled: null,
    pocketshellLastDetectedAt: null,
    pocketshellCliVersion: '1.2.3',
    pocketshellExpectedCliVersion: null,
    pocketshellVersionCompatible: null,
    pocketshellDaemonRunning: null,
    pocketshellDaemonEnabled: null,
    usageCommandOverride: null,
    claudeProfilesJson: '{"x":1}',
    codexProfilesJson: null,
    ...over,
  };
}

describe('migration: buildConnectionToAliasMap', () => {
  it('maps hostname|port|user -> alias for usable entries', () => {
    const parsed = parseSshConfigString(`
Host prod
  HostName prod.example.com
  User deploy
  IdentityFile ~/.ssh/prod
`);
    const map = buildConnectionToAliasMap(parsed, { defaultUsername: 'local' });
    expect(map.get('prod.example.com|22|deploy')).toBe('prod');
  });

  it('skips unusable entries (no alias mapped)', () => {
    const parsed = parseSshConfigString(`
Host via-bastion
  HostName private.example.com
  IdentityFile ~/.ssh/private
  ProxyJump bastion
`);
    const map = buildConnectionToAliasMap(parsed, { defaultUsername: 'local' });
    expect(map.size).toBe(0);
  });
});

describe('migration: migrateLegacyHosts', () => {
  let store: HostMetadataStore;
  let deleted: number[];

  beforeEach(async () => {
    store = new HostMetadataStore(await createTestDb(), ':memory:');
    deleted = [];
  });

  it('matches a legacy row to its config alias and carries metadata forward', () => {
    const parsed = parseSshConfigString(`
Host prod
  HostName prod.example.com
  User deploy
  IdentityFile ~/.ssh/prod
`);
    const result = migrateLegacyHosts([legacyHost()], parsed, store, id => deleted.push(id));

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].alias).toBe('prod');
    expect(result.unmatched).toEqual([]);
    expect(deleted).toEqual([1]);

    const m = store.get(hostIdentityForAlias('prod'));
    expect(m?.pocketshellCliVersion).toBe('1.2.3');
    expect(m?.tmuxInstalled).toBe(true);
    expect(m?.claudeProfilesJson).toBe('{"x":1}');
    expect(m?.lastConnectedAt).toBe(200);
    expect(m?.enabled).toBe(true);
  });

  it('reports unmatched legacy rows whose details are absent from the config', () => {
    const parsed = parseSshConfigString(`
Host other
  HostName other.example.com
  User someone
  IdentityFile ~/.ssh/other
`);
    const result = migrateLegacyHosts([legacyHost()], parsed, store, () => undefined);

    expect(result.matched).toEqual([]);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0].hostname).toBe('prod.example.com');
    expect(result.unmatched[0].reason).toMatch(/no matching Host entry/);
    // Unmatched rows are not written to the metadata store.
    expect(store.list()).toEqual([]);
  });

  it('keeps the first legacy row when two map to the same alias', () => {
    const parsed = parseSshConfigString(`
Host prod
  HostName prod.example.com
  User deploy
  IdentityFile ~/.ssh/prod
`);
    const a = legacyHost({ id: 1, pocketshellCliVersion: 'first' });
    const b = legacyHost({ id: 2, name: 'prod', pocketshellCliVersion: 'second' });
    const result = migrateLegacyHosts([a, b], parsed, store, () => undefined);

    expect(result.matched).toHaveLength(1);
    expect(result.unmatched).toHaveLength(1);
    expect(store.get(hostIdentityForAlias('prod'))?.pocketshellCliVersion).toBe('first');
  });

  it('deleteLegacy=false preserves legacy rows', () => {
    const parsed = parseSshConfigString(`
Host prod
  HostName prod.example.com
  User deploy
  IdentityFile ~/.ssh/prod
`);
    migrateLegacyHosts(
      [legacyHost()],
      parsed,
      store,
      id => deleted.push(id),
      { deleteLegacy: false },
    );
    expect(deleted).toEqual([]);
  });

  it('reports an unmatched row on run 1 and suppresses it on run 2 (same store)', () => {
    const parsed = parseSshConfigString(`
Host other
  HostName other.example.com
  User someone
  IdentityFile ~/.ssh/other
`);
    const legacy = legacyHost(); // prod.example.com — no matching config stanza

    // Run 1: unmatched row is reported.
    const r1 = migrateLegacyHosts([legacy], parsed, store, () => undefined);
    expect(r1.matched).toEqual([]);
    expect(r1.unmatched).toHaveLength(1);
    expect(r1.unmatched[0].hostname).toBe('prod.example.com');

    // Run 2: same legacy row, same store — suppressed (already seen).
    const r2 = migrateLegacyHosts([legacy], parsed, store, () => undefined);
    expect(r2.matched).toEqual([]);
    expect(r2.unmatched).toHaveLength(0);
  });

  it('still migrates+deletes a matched row even after it was seen as unmatched', () => {
    // Run 1: legacy row is unmatched against this config.
    const parsedNoMatch = parseSshConfigString(`
Host other
  HostName other.example.com
  User someone
`);
    const legacy = legacyHost();
    const r1 = migrateLegacyHosts([legacy], parsedNoMatch, store, () => undefined);
    expect(r1.unmatched).toHaveLength(1);

    // Run 2: config now has the stanza; the row matches and migrates normally
    // (the seen marker is inert for the matched path). It is also deleted.
    const parsedMatch = parseSshConfigString(`
Host prod
  HostName prod.example.com
  User deploy
  IdentityFile ~/.ssh/prod
`);
    const r2 = migrateLegacyHosts([legacy], parsedMatch, store, id => deleted.push(id));
    expect(r2.matched).toHaveLength(1);
    expect(r2.matched[0].alias).toBe('prod');
    expect(r2.unmatched).toHaveLength(0);
    expect(deleted).toEqual([1]);
    expect(store.get(hostIdentityForAlias('prod'))?.pocketshellCliVersion).toBe('1.2.3');
  });

  it('marks collision-unmatched rows as seen too (not re-reported on run 2)', () => {
    const parsed = parseSshConfigString(`
Host prod
  HostName prod.example.com
  User deploy
  IdentityFile ~/.ssh/prod
`);
    const a = legacyHost({ id: 1, pocketshellCliVersion: 'first' });
    const b = legacyHost({ id: 2, name: 'prod', pocketshellCliVersion: 'second' });

    const r1 = migrateLegacyHosts([a, b], parsed, store, () => undefined);
    expect(r1.matched).toHaveLength(1);
    expect(r1.unmatched).toHaveLength(1);

    const r2 = migrateLegacyHosts([a, b], parsed, store, () => undefined);
    expect(r2.matched).toHaveLength(1);
    expect(r2.unmatched).toHaveLength(0);
  });
});

describe('migration: unmatched "seen" suppression across stores', () => {
  let store: HostMetadataStore;

  beforeEach(async () => {
    store = new HostMetadataStore(await createTestDb(), ':memory:');
  });

  it('clearMigrationSeen re-surfaces a previously suppressed unmatched row', () => {
    const parsed = parseSshConfigString(`
Host other
  HostName other.example.com
  User someone
`);
    const legacy = legacyHost();

    expect(migrateLegacyHosts([legacy], parsed, store, () => undefined).unmatched).toHaveLength(1);
    expect(migrateLegacyHosts([legacy], parsed, store, () => undefined).unmatched).toHaveLength(0);

    store.clearMigrationSeen();
    expect(migrateLegacyHosts([legacy], parsed, store, () => undefined).unmatched).toHaveLength(1);
  });
});
