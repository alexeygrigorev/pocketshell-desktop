/**
 * SQLite-backed host storage for PocketShell Desktop.
 *
 * Provides CRUD operations for SSH host entries. Each host stores connection
 * parameters (hostname, port, username, keyPath), bootstrap/probe cache fields,
 * and timestamps.
 *
 * Uses sql.js (pure WASM SQLite) instead of better-sqlite3 to avoid
 * native module ABI mismatches with Electron's extension host.
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
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
  keyPath: string;

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
  key_path                    TEXT    NOT NULL,

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
  codex_profiles_json         TEXT
);
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
  key_path: string;
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
    keyPath: row.key_path,
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
  private dbPath: string;

  constructor(private db: SqlJsDatabase, dbPath: string) {
    this.dbPath = dbPath;
    this.db.run(CREATE_TABLE_SQL);
  }

  /** Persist the database to disk. Skipped for in-memory databases. */
  private save(): void {
    if (this.dbPath === ':memory:') return;
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  /** Return all hosts ordered by name. */
  list(): Host[] {
    const results = this.db.exec('SELECT * FROM hosts ORDER BY name');
    if (results.length === 0) return [];
    const cols = results[0].columns;
    return results[0].values.map(row => rowToHost(mapRow(cols, row)));
  }

  /** Return a single host by id, or undefined if not found. */
  get(id: number): Host | undefined {
    const stmt = this.db.prepare('SELECT * FROM hosts WHERE id = ?');
    stmt.bind([id]);
    try {
      if (stmt.step()) {
        const cols = stmt.getColumnNames();
        const values = stmt.get();
        return rowToHost(mapRow(cols, values));
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  /** Insert a new host. Returns the auto-generated id. */
  add(host: NewHost): number {
    const now = Date.now();
    this.db.run(
      `INSERT INTO hosts (
        name, hostname, port, username, key_path,
        max_auto_port, skip_ports_below, scan_interval_sec, enabled,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        host.name,
        host.hostname,
        host.port,
        host.username,
        host.keyPath,
        host.maxAutoPort,
        host.skipPortsBelow,
        host.scanIntervalSec,
        host.enabled ? 1 : 0,
        now,
      ],
    );
    // Get the last inserted rowid
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const id = result[0].values[0][0] as number;
    this.save();
    return id;
  }

  /** Update an existing host. Returns true if a row was updated. */
  update(host: Host): boolean {
    const before = this.get(host.id);
    if (!before) return false;

    this.db.run(
      `UPDATE hosts SET
        name = ?, hostname = ?, port = ?, username = ?, key_path = ?,
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
      [
        host.name,
        host.hostname,
        host.port,
        host.username,
        host.keyPath,
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
      ],
    );
    this.save();
    return true;
  }

  /** Delete a host by id. Returns true if a row was deleted. */
  delete(id: number): boolean {
    const before = this.get(id);
    if (!before) return false;

    this.db.run('DELETE FROM hosts WHERE id = ?', [id]);
    this.save();
    return true;
  }

  /** Update the lastConnectedAt timestamp for a host. */
  touchConnected(id: number): void {
    this.db.run(
      'UPDATE hosts SET last_connected_at = ? WHERE id = ?',
      [Date.now(), id],
    );
    this.save();
  }

  /** Return all enabled hosts. */
  listEnabled(): Host[] {
    const results = this.db.exec('SELECT * FROM hosts WHERE enabled = 1 ORDER BY name');
    if (results.length === 0) return [];
    const cols = results[0].columns;
    return results[0].values.map(row => rowToHost(mapRow(cols, row)));
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

/**
 * Map a sql.js result row (parallel columns + values arrays) to a
 * column-name-keyed object.
 */
function mapRow(columns: string[], values: (string | number | null | Uint8Array)[]): HostRow {
  const obj: Record<string, string | number | null | Uint8Array> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = values[i];
  }
  return obj as unknown as HostRow;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the host store.
 *
 * sql.js requires async WASM initialization, so this function is async.
 *
 * @param dbPath - Path to the SQLite database file.
 *   Defaults to `~/.pocketshell/hosts.db`.
 * @returns A `HostStore` instance ready for use.
 */
export async function initStore(dbPath?: string): Promise<HostStore> {
  const resolvedPath =
    dbPath ?? path.join(os.homedir(), '.pocketshell', 'hosts.db');

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const SQL = await initSqlJs({
    locateFile: (file: string) =>
      path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'sql.js', 'dist', file),
  });

  let db: SqlJsDatabase;
  if (fs.existsSync(resolvedPath)) {
    const buffer = fs.readFileSync(resolvedPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  return new HostStore(db, resolvedPath);
}

/**
 * Create a HostStore from an existing sql.js Database instance.
 * Used for testing with in-memory databases.
 */
export function createHostStore(db: SqlJsDatabase, dbPath?: string): HostStore {
  return new HostStore(db, dbPath ?? ':memory:');
}
