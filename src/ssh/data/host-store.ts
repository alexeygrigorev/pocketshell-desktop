/**
 * SQLite-backed host storage for PocketShell Desktop.
 *
 * Provides CRUD operations for SSH host entries. Each host stores connection
 * parameters (hostname, port, username, keyId), bootstrap/probe cache fields,
 * and timestamps.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** SSH host entry stored in the `hosts` table. */
export interface Host {
  id: number;
  name: string;
  hostname: string;
  port: number;
  username: string;
  keyId: number;

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

/** Fields required when creating a new host (id and timestamps are auto-set). */
export type NewHost = Omit<
  Host,
  | 'id'
  | 'createdAt'
  | 'lastConnectedAt'
  | 'tmuxInstalled'
  | 'lastBootstrapAt'
  | 'pocketshellInstalled'
  | 'pocketshellLastDetectedAt'
  | 'pocketshellCliVersion'
  | 'pocketshellExpectedCliVersion'
  | 'pocketshellVersionCompatible'
  | 'pocketshellDaemonRunning'
  | 'pocketshellDaemonEnabled'
  | 'usageCommandOverride'
  | 'claudeProfilesJson'
  | 'codexProfilesJson'
>;

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS hosts (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  name                        TEXT    NOT NULL,
  hostname                    TEXT    NOT NULL,
  port                        INTEGER NOT NULL DEFAULT 22,
  username                    TEXT    NOT NULL,
  key_id                      INTEGER NOT NULL,

  max_auto_port               INTEGER NOT NULL DEFAULT 10000,
  skip_ports_below            INTEGER NOT NULL DEFAULT 1000,
  scan_interval_sec           INTEGER NOT NULL DEFAULT 5,
  enabled                     INTEGER NOT NULL DEFAULT 0,

  created_at                  INTEGER NOT NULL,
  last_connected_at           INTEGER,

  tmux_installed              INTEGER,
  last_bootstrap_at           INTEGER,
  pocketshell_installed       INTEGER,
  pocketshell_last_detected_at INTEGER,
  pocketshell_cli_version     TEXT,
  pocketshell_expected_cli_version TEXT,
  pocketshell_version_compatible INTEGER,
  pocketshell_daemon_running  INTEGER,
  pocketshell_daemon_enabled  INTEGER,
  usage_command_override      TEXT,

  claude_profiles_json        TEXT,
  codex_profiles_json         TEXT,

  FOREIGN KEY (key_id) REFERENCES ssh_keys(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hosts_key_id ON hosts(key_id);
`;

// ---------------------------------------------------------------------------
// Row <-> Host mapping
// ---------------------------------------------------------------------------

/** Column order must match the CREATE TABLE statement. */
interface HostRow {
  id: number;
  name: string;
  hostname: string;
  port: number;
  username: string;
  key_id: number;
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

function rowToHost(row: HostRow): Host {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    port: row.port,
    username: row.username,
    keyId: row.key_id,
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
// HostStore class
// ---------------------------------------------------------------------------

export class HostStore {
  constructor(private db: Database.Database) {
    // Enable foreign keys and ensure tables exist
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLE_SQL);
  }

  /** Return all hosts ordered by name. */
  list(): Host[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM hosts
         ORDER BY name`,
      )
      .all() as HostRow[];
    return rows.map(rowToHost);
  }

  /** Return a single host by id, or undefined if not found. */
  get(id: number): Host | undefined {
    const row = this.db
      .prepare(`SELECT * FROM hosts WHERE id = ?`)
      .get(id) as HostRow | undefined;
    return row ? rowToHost(row) : undefined;
  }

  /** Insert a new host. Returns the auto-generated id. */
  add(host: NewHost): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO hosts (
          name, hostname, port, username, key_id,
          max_auto_port, skip_ports_below, scan_interval_sec, enabled,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        host.name,
        host.hostname,
        host.port,
        host.username,
        host.keyId,
        host.maxAutoPort,
        host.skipPortsBelow,
        host.scanIntervalSec,
        host.enabled ? 1 : 0,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  /** Update an existing host. Returns true if a row was updated. */
  update(host: Host): boolean {
    const result = this.db
      .prepare(
        `UPDATE hosts SET
          name = ?, hostname = ?, port = ?, username = ?, key_id = ?,
          max_auto_port = ?, skip_ports_below = ?, scan_interval_sec = ?, enabled = ?,
          last_connected_at = ?,
          tmux_installed = ?, last_bootstrap_at = ?,
          pocketshell_installed = ?, pocketshell_last_detected_at = ?,
          pocketshell_cli_version = ?, pocketshell_expected_cli_version = ?,
          pocketshell_version_compatible = ?,
          pocketshell_daemon_running = ?, pocketshell_daemon_enabled = ?,
          usage_command_override = ?,
          claude_profiles_json = ?, codex_profiles_json = ?
        WHERE id = ?`,
      )
      .run(
        host.name,
        host.hostname,
        host.port,
        host.username,
        host.keyId,
        host.maxAutoPort,
        host.skipPortsBelow,
        host.scanIntervalSec,
        host.enabled ? 1 : 0,
        host.lastConnectedAt,
        host.tmuxInstalled === null ? null : host.tmuxInstalled ? 1 : 0,
        host.lastBootstrapAt,
        host.pocketshellInstalled === null ? null : host.pocketshellInstalled ? 1 : 0,
        host.pocketshellLastDetectedAt,
        host.pocketshellCliVersion,
        host.pocketshellExpectedCliVersion,
        host.pocketshellVersionCompatible === null
          ? null
          : host.pocketshellVersionCompatible
            ? 1
            : 0,
        host.pocketshellDaemonRunning === null ? null : host.pocketshellDaemonRunning ? 1 : 0,
        host.pocketshellDaemonEnabled === null ? null : host.pocketshellDaemonEnabled ? 1 : 0,
        host.usageCommandOverride,
        host.claudeProfilesJson,
        host.codexProfilesJson,
        host.id,
      );
    return result.changes > 0;
  }

  /** Delete a host by id. Returns true if a row was deleted. */
  delete(id: number): boolean {
    const result = this.db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** Update the lastConnectedAt timestamp for a host. */
  touchConnected(id: number): void {
    this.db
      .prepare('UPDATE hosts SET last_connected_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  /** Return all enabled hosts. */
  listEnabled(): Host[] {
    const rows = this.db
      .prepare(`SELECT * FROM hosts WHERE enabled = 1 ORDER BY name`)
      .all() as HostRow[];
    return rows.map(rowToHost);
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the host store.
 *
 * @param dbPath - Path to the SQLite database file.
 *   Defaults to `~/.pocketshell/hosts.db`.
 * @returns A `HostStore` instance ready for use.
 */
export function initStore(dbPath?: string): HostStore {
  const resolvedPath =
    dbPath ?? path.join(os.homedir(), '.pocketshell', 'hosts.db');

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.exec(CREATE_TABLE_SQL);

  return new HostStore(db);
}
