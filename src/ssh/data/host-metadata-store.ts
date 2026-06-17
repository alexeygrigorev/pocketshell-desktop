/**
 * PocketShell host-metadata store.
 *
 * `~/.ssh/config` is the single source of truth for the host list and for
 * connection details. This store holds ONLY PocketShell-specific metadata
 * (port-forwarding defaults, enabled flag, bootstrap cache, agent profiles)
 * keyed by a stable identity derived from the SSH config entry (see
 * `ssh-host-resolver.ts`). It never stores hostname/port/user/keyPath — those
 * are resolved from the config at use time.
 *
 * Uses sql.js (pure WASM SQLite) to match the rest of the storage layer.
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** PocketShell-specific metadata for a host, keyed by stable identity. */
export interface HostMetadata {
  /** Stable identity string (see `hostIdentityForAlias`). */
  identity: string;
  /** The alias this metadata was last associated with (for display/debug). */
  alias: string;

  // Port-forwarding defaults
  maxAutoPort: number;
  skipPortsBelow: number;
  scanIntervalSec: number;
  enabled: boolean;

  // Timestamps (epoch ms)
  createdAt: number;
  lastConnectedAt: number | null;

  // Bootstrap cache (null = never probed)
  tmuxInstalled: boolean | null;
  lastBootstrapAt: number | null;
  pocketshellInstalled: boolean | null;
  pocketshellLastDetectedAt: number | null;
  pocketshellCliVersion: string | null;
  pocketshellExpectedCliVersion: string | null;
  pocketshellVersionCompatible: boolean | null;
  pocketshellDaemonRunning: boolean | null;
  pocketshellDaemonEnabled: boolean | null;
  usageCommandOverride: string | null;

  // Per-host agent profile config (JSON strings)
  claudeProfilesJson: string | null;
  codexProfilesJson: string | null;
}

/** Fields that can be patched on an existing metadata row. */
export type HostMetadataPatch = Partial<
  Omit<HostMetadata, 'identity'> & { alias: string }
>;

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS host_metadata (
  identity                     TEXT PRIMARY KEY,
  alias                        TEXT NOT NULL,

  max_auto_port                INTEGER NOT NULL DEFAULT 10000,
  skip_ports_below             INTEGER NOT NULL DEFAULT 1000,
  scan_interval_sec            INTEGER NOT NULL DEFAULT 5,
  enabled                      INTEGER NOT NULL DEFAULT 0,

  created_at                   INTEGER NOT NULL,
  last_connected_at            INTEGER,

  tmux_installed               INTEGER,
  last_bootstrap_at            INTEGER,
  pocketshell_installed        INTEGER,
  pocketshell_last_detected_at INTEGER,
  pocketshell_cli_version      TEXT,
  pocketshell_expected_cli_version TEXT,
  pocketshell_version_compatible INTEGER,
  pocketshell_daemon_running   INTEGER,
  pocketshell_daemon_enabled   INTEGER,
  usage_command_override       TEXT,

  claude_profiles_json         TEXT,
  codex_profiles_json          TEXT
);
`;

/**
 * Side table recording which unmatched legacy rows the migration has already
 * reported, so each is surfaced at most once across activations (see
 * `host-metadata-migration.ts`). Keyed by `hostname|port|user` (lowercased).
 */
const CREATE_SEEN_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS migration_seen_unmatched (
  key    TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
`;

interface MetadataRow {
  identity: string;
  alias: string;
  max_auto_port: number;
  skip_ports_below: number;
  scan_interval_sec: number;
  enabled: number;
  created_at: number;
  last_connected_at: number | null;
  tmux_installed: number | null;
  last_bootstrap_at: number | null;
  pocketshell_installed: number | null;
  pocketshell_last_detected_at: number | null;
  pocketshell_cli_version: string | null;
  pocketshell_expected_cli_version: string | null;
  pocketshell_version_compatible: number | null;
  pocketshell_daemon_running: number | null;
  pocketshell_daemon_enabled: number | null;
  usage_command_override: string | null;
  claude_profiles_json: string | null;
  codex_profiles_json: string | null;
}

function rowToMetadata(row: MetadataRow): HostMetadata {
  return {
    identity: row.identity,
    alias: row.alias,
    maxAutoPort: row.max_auto_port,
    skipPortsBelow: row.skip_ports_below,
    scanIntervalSec: row.scan_interval_sec,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    lastConnectedAt: row.last_connected_at,
    tmuxInstalled: row.tmux_installed === null ? null : row.tmux_installed !== 0,
    lastBootstrapAt: row.last_bootstrap_at,
    pocketshellInstalled:
      row.pocketshell_installed === null ? null : row.pocketshell_installed !== 0,
    pocketshellLastDetectedAt: row.pocketshell_last_detected_at,
    pocketshellCliVersion: row.pocketshell_cli_version,
    pocketshellExpectedCliVersion: row.pocketshell_expected_cli_version,
    pocketshellVersionCompatible:
      row.pocketshell_version_compatible === null
        ? null
        : row.pocketshell_version_compatible !== 0,
    pocketshellDaemonRunning:
      row.pocketshell_daemon_running === null ? null : row.pocketshell_daemon_running !== 0,
    pocketshellDaemonEnabled:
      row.pocketshell_daemon_enabled === null ? null : row.pocketshell_daemon_enabled !== 0,
    usageCommandOverride: row.usage_command_override,
    claudeProfilesJson: row.claude_profiles_json,
    codexProfilesJson: row.codex_profiles_json,
  };
}

// ---------------------------------------------------------------------------
// HostMetadataStore
// ---------------------------------------------------------------------------

export class HostMetadataStore {
  constructor(private db: SqlJsDatabase, private dbPath: string) {
    this.db.run(CREATE_TABLE_SQL);
    this.db.run(CREATE_SEEN_TABLE_SQL);
  }

  /** Persist the database to disk. Skipped for in-memory databases. */
  private save(): void {
    if (this.dbPath === ':memory:') return;
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  /** Return all metadata rows, ordered by alias. */
  list(): HostMetadata[] {
    const results = this.db.exec('SELECT * FROM host_metadata ORDER BY alias');
    if (results.length === 0) return [];
    const cols = results[0].columns;
    return results[0].values.map(row => rowToMetadata(mapRow(cols, row)));
  }

  /** Return all metadata as a Map keyed by identity (convenient for merging). */
  asMap(): Map<string, HostMetadata> {
    const map = new Map<string, HostMetadata>();
    for (const entry of this.list()) {
      map.set(entry.identity, entry);
    }
    return map;
  }

  /** Get a single metadata row by identity. */
  get(identity: string): HostMetadata | undefined {
    const stmt = this.db.prepare('SELECT * FROM host_metadata WHERE identity = ?');
    stmt.bind([identity]);
    try {
      if (stmt.step()) {
        const cols = stmt.getColumnNames();
        const values = stmt.get();
        return rowToMetadata(mapRow(cols, values));
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  /**
   * Upsert a metadata row. Creates a new row with defaults if absent, or
   * patches the supplied fields onto an existing row.
   */
  upsert(identity: string, alias: string, patch: HostMetadataPatch = {}): HostMetadata {
    const existing = this.get(identity);
    const now = Date.now();
    if (!existing) {
      const created: HostMetadata = {
        identity,
        alias,
        maxAutoPort: patch.maxAutoPort ?? 10000,
        skipPortsBelow: patch.skipPortsBelow ?? 1000,
        scanIntervalSec: patch.scanIntervalSec ?? 5,
        enabled: patch.enabled ?? true,
        createdAt: patch.createdAt ?? now,
        lastConnectedAt: patch.lastConnectedAt ?? null,
        tmuxInstalled: patch.tmuxInstalled ?? null,
        lastBootstrapAt: patch.lastBootstrapAt ?? null,
        pocketshellInstalled: patch.pocketshellInstalled ?? null,
        pocketshellLastDetectedAt: patch.pocketshellLastDetectedAt ?? null,
        pocketshellCliVersion: patch.pocketshellCliVersion ?? null,
        pocketshellExpectedCliVersion: patch.pocketshellExpectedCliVersion ?? null,
        pocketshellVersionCompatible: patch.pocketshellVersionCompatible ?? null,
        pocketshellDaemonRunning: patch.pocketshellDaemonRunning ?? null,
        pocketshellDaemonEnabled: patch.pocketshellDaemonEnabled ?? null,
        usageCommandOverride: patch.usageCommandOverride ?? null,
        claudeProfilesJson: patch.claudeProfilesJson ?? null,
        codexProfilesJson: patch.codexProfilesJson ?? null,
      };
      this.insertRow(created);
      this.save();
      return created;
    }

    const updated: HostMetadata = {
      ...existing,
      alias: patch.alias ?? existing.alias,
      maxAutoPort: patch.maxAutoPort ?? existing.maxAutoPort,
      skipPortsBelow: patch.skipPortsBelow ?? existing.skipPortsBelow,
      scanIntervalSec: patch.scanIntervalSec ?? existing.scanIntervalSec,
      enabled: patch.enabled ?? existing.enabled,
      lastConnectedAt: patch.lastConnectedAt ?? existing.lastConnectedAt,
      tmuxInstalled: patch.tmuxInstalled ?? existing.tmuxInstalled,
      lastBootstrapAt: patch.lastBootstrapAt ?? existing.lastBootstrapAt,
      pocketshellInstalled: patch.pocketshellInstalled ?? existing.pocketshellInstalled,
      pocketshellLastDetectedAt:
        patch.pocketshellLastDetectedAt ?? existing.pocketshellLastDetectedAt,
      pocketshellCliVersion: patch.pocketshellCliVersion ?? existing.pocketshellCliVersion,
      pocketshellExpectedCliVersion:
        patch.pocketshellExpectedCliVersion ?? existing.pocketshellExpectedCliVersion,
      pocketshellVersionCompatible:
        patch.pocketshellVersionCompatible ?? existing.pocketshellVersionCompatible,
      pocketshellDaemonRunning: patch.pocketshellDaemonRunning ?? existing.pocketshellDaemonRunning,
      pocketshellDaemonEnabled:
        patch.pocketshellDaemonEnabled ?? existing.pocketshellDaemonEnabled,
      usageCommandOverride: patch.usageCommandOverride ?? existing.usageCommandOverride,
      claudeProfilesJson: patch.claudeProfilesJson ?? existing.claudeProfilesJson,
      codexProfilesJson: patch.codexProfilesJson ?? existing.codexProfilesJson,
    };
    this.updateRow(updated);
    this.save();
    return updated;
  }

  /** Update the lastConnectedAt timestamp for a host identity. */
  touchConnected(identity: string): void {
    this.db.run(
      'UPDATE host_metadata SET last_connected_at = ? WHERE identity = ?',
      [Date.now(), identity],
    );
    this.save();
  }

  /** Delete a metadata row by identity. */
  delete(identity: string): boolean {
    const before = this.get(identity);
    if (!before) return false;
    this.db.run('DELETE FROM host_metadata WHERE identity = ?', [identity]);
    this.save();
    return true;
  }

  // -------------------------------------------------------------------------
  // Migration "seen" set (unmatched legacy rows already reported once).
  // -------------------------------------------------------------------------

  /** Has the given unmatched-row key already been reported on a prior run? */
  isMigrationSeen(key: string): boolean {
    const stmt = this.db.prepare(
      'SELECT 1 FROM migration_seen_unmatched WHERE key = ?',
    );
    stmt.bind([key]);
    try {
      return stmt.step();
    } finally {
      stmt.free();
    }
  }

  /**
   * Record that an unmatched row with the given key has been reported.
   * Returns `true` if this is the first time (key newly inserted), `false` if
   * it was already present. Idempotent.
   */
  markMigrationSeen(key: string): boolean {
    const before = this.isMigrationSeen(key);
    this.db.run(
      'INSERT OR IGNORE INTO migration_seen_unmatched (key, seen_at) VALUES (?, ?)',
      [key, Date.now()],
    );
    if (!before) {
      this.save();
    }
    return !before;
  }

  /** Forget all reported-unmatched markers (test/reset helper). */
  clearMigrationSeen(): void {
    this.db.run('DELETE FROM migration_seen_unmatched');
    this.save();
  }

  private insertRow(m: HostMetadata): void {
    this.db.run(
      `INSERT INTO host_metadata (
        identity, alias,
        max_auto_port, skip_ports_below, scan_interval_sec, enabled,
        created_at, last_connected_at,
        tmux_installed, last_bootstrap_at,
        pocketshell_installed, pocketshell_last_detected_at,
        pocketshell_cli_version, pocketshell_expected_cli_version,
        pocketshell_version_compatible,
        pocketshell_daemon_running, pocketshell_daemon_enabled,
        usage_command_override,
        claude_profiles_json, codex_profiles_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        m.identity,
        m.alias,
        m.maxAutoPort,
        m.skipPortsBelow,
        m.scanIntervalSec,
        m.enabled ? 1 : 0,
        m.createdAt,
        m.lastConnectedAt,
        m.tmuxInstalled === null ? null : m.tmuxInstalled ? 1 : 0,
        m.lastBootstrapAt,
        m.pocketshellInstalled === null ? null : m.pocketshellInstalled ? 1 : 0,
        m.pocketshellLastDetectedAt,
        m.pocketshellCliVersion,
        m.pocketshellExpectedCliVersion,
        m.pocketshellVersionCompatible === null ? null : m.pocketshellVersionCompatible ? 1 : 0,
        m.pocketshellDaemonRunning === null ? null : m.pocketshellDaemonRunning ? 1 : 0,
        m.pocketshellDaemonEnabled === null ? null : m.pocketshellDaemonEnabled ? 1 : 0,
        m.usageCommandOverride,
        m.claudeProfilesJson,
        m.codexProfilesJson,
      ],
    );
  }

  private updateRow(m: HostMetadata): void {
    this.db.run(
      `UPDATE host_metadata SET
        alias = ?,
        max_auto_port = ?, skip_ports_below = ?, scan_interval_sec = ?, enabled = ?,
        last_connected_at = ?,
        tmux_installed = ?, last_bootstrap_at = ?,
        pocketshell_installed = ?, pocketshell_last_detected_at = ?,
        pocketshell_cli_version = ?, pocketshell_expected_cli_version = ?,
        pocketshell_version_compatible = ?,
        pocketshell_daemon_running = ?, pocketshell_daemon_enabled = ?,
        usage_command_override = ?,
        claude_profiles_json = ?, codex_profiles_json = ?
      WHERE identity = ?`,
      [
        m.alias,
        m.maxAutoPort,
        m.skipPortsBelow,
        m.scanIntervalSec,
        m.enabled ? 1 : 0,
        m.lastConnectedAt,
        m.tmuxInstalled === null ? null : m.tmuxInstalled ? 1 : 0,
        m.lastBootstrapAt,
        m.pocketshellInstalled === null ? null : m.pocketshellInstalled ? 1 : 0,
        m.pocketshellLastDetectedAt,
        m.pocketshellCliVersion,
        m.pocketshellExpectedCliVersion,
        m.pocketshellVersionCompatible === null ? null : m.pocketshellVersionCompatible ? 1 : 0,
        m.pocketshellDaemonRunning === null ? null : m.pocketshellDaemonRunning ? 1 : 0,
        m.pocketshellDaemonEnabled === null ? null : m.pocketshellDaemonEnabled ? 1 : 0,
        m.usageCommandOverride,
        m.claudeProfilesJson,
        m.codexProfilesJson,
        m.identity,
      ],
    );
  }

  /** Close the database (call when done to free WASM memory). */
  close(): void {
    this.save();
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Row mapping helper
// ---------------------------------------------------------------------------

function mapRow(
  columns: string[],
  values: (string | number | null | Uint8Array)[],
): MetadataRow {
  const obj: Record<string, string | number | null | Uint8Array> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = values[i];
  }
  return obj as unknown as MetadataRow;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the metadata store. Shares the same SQLite database file as the
 * legacy host store (`hosts.db`) so migration can read the old `hosts` table.
 */
export async function initMetadataStore(dbPath?: string): Promise<HostMetadataStore> {
  const resolvedPath = dbPath ?? path.join(os.homedir(), '.pocketshell', 'hosts.db');
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const SQL = await initSqlJs({
    locateFile: (file: string) =>
      path.join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', file),
  });

  let db: SqlJsDatabase;
  if (fs.existsSync(resolvedPath)) {
    const buffer = fs.readFileSync(resolvedPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  return new HostMetadataStore(db, resolvedPath);
}

/** Create a metadata store from an existing sql.js Database (for testing). */
export function createMetadataStore(db: SqlJsDatabase, dbPath?: string): HostMetadataStore {
  return new HostMetadataStore(db, dbPath ?? ':memory:');
}
