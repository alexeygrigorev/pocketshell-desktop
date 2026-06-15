/**
 * SQLite-backed watched folder storage.
 *
 * Keeps per-host workspace roots that can be shown on the host detail page.
 * Uses sql.js so the same code can run inside the VS Code extension host.
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export type WatchedFolderSource = 'manual' | 'discovered';

export interface WatchedFolder {
  id: number;
  hostId: number;
  label: string;
  path: string;
  orderIndex: number;
  source: WatchedFolderSource;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NewWatchedFolder {
  hostId: number;
  label?: string;
  path: string;
  source?: WatchedFolderSource;
  enabled?: boolean;
}

export interface WatchedFolderUpdate {
  label?: string;
  path?: string;
  source?: WatchedFolderSource;
  enabled?: boolean;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS watched_folders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id        INTEGER NOT NULL,
  label          TEXT    NOT NULL,
  path           TEXT    NOT NULL,
  order_index    INTEGER NOT NULL,
  source         TEXT    NOT NULL DEFAULT 'manual',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(host_id, path)
);

CREATE INDEX IF NOT EXISTS idx_watched_folders_host_order
  ON watched_folders(host_id, order_index, label);
`;

interface WatchedFolderRow {
  id: number;
  host_id: number;
  label: string;
  path: string;
  order_index: number;
  source: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export class WatchedFolderStore {
  constructor(private db: SqlJsDatabase, private dbPath: string) {
    this.db.run(CREATE_TABLE_SQL);
  }

  list(hostId: number): WatchedFolder[] {
    const stmt = this.db.prepare(
      'SELECT * FROM watched_folders WHERE host_id = ? ORDER BY order_index, label, id',
    );
    stmt.bind([hostId]);
    try {
      const rows: WatchedFolder[] = [];
      while (stmt.step()) {
        rows.push(rowToWatchedFolder(mapRow(stmt.getColumnNames(), stmt.get())));
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(id: number): WatchedFolder | undefined {
    const stmt = this.db.prepare('SELECT * FROM watched_folders WHERE id = ?');
    stmt.bind([id]);
    try {
      if (!stmt.step()) {
        return undefined;
      }
      return rowToWatchedFolder(mapRow(stmt.getColumnNames(), stmt.get()));
    } finally {
      stmt.free();
    }
  }

  add(folder: NewWatchedFolder): number {
    const existing = this.getEquivalent(folder.hostId, folder.path);
    if (existing) {
      return existing.id;
    }

    const now = Date.now();
    const orderIndex = this.nextOrderIndex(folder.hostId);
    const label = normalizeLabel(folder.label, folder.path);
    this.db.run(
      `INSERT INTO watched_folders (
        host_id, label, path, order_index, source, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        folder.hostId,
        label,
        folder.path,
        orderIndex,
        folder.source ?? 'manual',
        (folder.enabled ?? true) ? 1 : 0,
        now,
        now,
      ],
    );
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const id = result[0].values[0][0] as number;
    this.save();
    return id;
  }

  update(id: number, patch: WatchedFolderUpdate): boolean {
    const before = this.get(id);
    if (!before) {
      return false;
    }

    const pathValue = patch.path ?? before.path;
    const conflict = this.getEquivalent(before.hostId, pathValue, id);
    if (conflict) {
      return false;
    }
    const labelValue = normalizeLabel(patch.label ?? before.label, pathValue);
    this.db.run(
      `UPDATE watched_folders SET
        label = ?, path = ?, source = ?, enabled = ?, updated_at = ?
      WHERE id = ?`,
      [
        labelValue,
        pathValue,
        patch.source ?? before.source,
        (patch.enabled ?? before.enabled) ? 1 : 0,
        Date.now(),
        id,
      ],
    );
    this.save();
    return true;
  }

  delete(id: number): boolean {
    const before = this.get(id);
    if (!before) {
      return false;
    }

    this.db.run('DELETE FROM watched_folders WHERE id = ?', [id]);
    this.compactOrder(before.hostId);
    this.save();
    return true;
  }

  move(id: number, direction: 'up' | 'down'): boolean {
    const folder = this.get(id);
    if (!folder) {
      return false;
    }

    const folders = this.list(folder.hostId);
    const index = folders.findIndex((item) => item.id === id);
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || swapIndex < 0 || swapIndex >= folders.length) {
      return false;
    }

    const other = folders[swapIndex];
    this.db.run('UPDATE watched_folders SET order_index = ?, updated_at = ? WHERE id = ?', [
      other.orderIndex,
      Date.now(),
      folder.id,
    ]);
    this.db.run('UPDATE watched_folders SET order_index = ?, updated_at = ? WHERE id = ?', [
      folder.orderIndex,
      Date.now(),
      other.id,
    ]);
    this.save();
    return true;
  }

  reorder(hostId: number, ids: number[]): boolean {
    const existing = this.list(hostId);
    if (existing.length !== ids.length) {
      return false;
    }
    const existingIds = new Set(existing.map((folder) => folder.id));
    if (!ids.every((id) => existingIds.has(id))) {
      return false;
    }

    const now = Date.now();
    ids.forEach((id, index) => {
      this.db.run('UPDATE watched_folders SET order_index = ?, updated_at = ? WHERE id = ?', [
        index,
        now,
        id,
      ]);
    });
    this.save();
    return true;
  }

  close(): void {
    this.save();
    this.db.close();
  }

  private getByPath(hostId: number, folderPath: string): WatchedFolder | undefined {
    const stmt = this.db.prepare('SELECT * FROM watched_folders WHERE host_id = ? AND path = ?');
    stmt.bind([hostId, folderPath]);
    try {
      if (!stmt.step()) {
        return undefined;
      }
      return rowToWatchedFolder(mapRow(stmt.getColumnNames(), stmt.get()));
    } finally {
      stmt.free();
    }
  }

  private getEquivalent(
    hostId: number,
    folderPath: string,
    excludeId?: number,
  ): WatchedFolder | undefined {
    const exact = this.getByPath(hostId, folderPath);
    if (exact && exact.id !== excludeId) {
      return exact;
    }

    const targetKeys = normalizedPathKeys(folderPath);
    return this.list(hostId).find((folder) =>
      folder.id !== excludeId &&
      hasPathKeyIntersection(targetKeys, normalizedPathKeys(folder.path)),
    );
  }

  private nextOrderIndex(hostId: number): number {
    const stmt = this.db.prepare(
      'SELECT COALESCE(MAX(order_index), -1) + 1 AS next_order FROM watched_folders WHERE host_id = ?',
    );
    stmt.bind([hostId]);
    try {
      return stmt.step() ? (stmt.get()[0] as number) : 0;
    } finally {
      stmt.free();
    }
  }

  private compactOrder(hostId: number): void {
    this.list(hostId).forEach((folder, index) => {
      this.db.run('UPDATE watched_folders SET order_index = ? WHERE id = ?', [index, folder.id]);
    });
  }

  private save(): void {
    if (this.dbPath === ':memory:') {
      return;
    }
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }
}

function rowToWatchedFolder(row: WatchedFolderRow): WatchedFolder {
  return {
    id: row.id,
    hostId: row.host_id,
    label: row.label,
    path: row.path,
    orderIndex: row.order_index,
    source: row.source === 'discovered' ? 'discovered' : 'manual',
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeLabel(label: string | undefined, folderPath: string): string {
  const trimmed = label?.trim();
  if (trimmed) {
    return trimmed;
  }
  const parts = folderPath.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || folderPath;
}

export function normalizedPathKeys(folderPath: string): string[] {
  const normalized = folderPath.trim().replace(/\/+$/, '') || folderPath.trim();
  const keys = new Set<string>();
  keys.add(normalized);

  const homeRelative = homeRelativePath(normalized);
  if (homeRelative) {
    keys.add(`HOME/${homeRelative}`);
  }

  return [...keys];
}

function homeRelativePath(folderPath: string): string | undefined {
  const tilde = folderPath.match(/^~\/(.+)$/);
  if (tilde) {
    return tilde[1];
  }
  const homeVar = folderPath.match(/^\$HOME\/(.+)$/);
  if (homeVar) {
    return homeVar[1];
  }
  const linuxHome = folderPath.match(/^\/home\/[^/]+\/(git|code|projects)(?:\/(.*))?$/);
  if (linuxHome) {
    return joinHomeRelative(linuxHome[1], linuxHome[2]);
  }
  const macHome = folderPath.match(/^\/Users\/[^/]+\/(git|code|projects)(?:\/(.*))?$/);
  if (macHome) {
    return joinHomeRelative(macHome[1], macHome[2]);
  }
  const rootHome = folderPath.match(/^\/root\/(git|code|projects)(?:\/(.*))?$/);
  if (rootHome) {
    return joinHomeRelative(rootHome[1], rootHome[2]);
  }
  return undefined;
}

function joinHomeRelative(root: string, suffix: string | undefined): string {
  return suffix ? `${root}/${suffix}` : root;
}

function hasPathKeyIntersection(left: string[], right: string[]): boolean {
  const rightKeys = new Set(right);
  return left.some((key) => rightKeys.has(key));
}

function mapRow(
  columns: string[],
  values: (string | number | null | Uint8Array)[],
): WatchedFolderRow {
  const obj: Record<string, string | number | null | Uint8Array> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = values[i];
  }
  return obj as unknown as WatchedFolderRow;
}

export async function initWatchedFolderStore(dbPath?: string): Promise<WatchedFolderStore> {
  const resolvedPath = dbPath ?? path.join(os.homedir(), '.pocketshell', 'watched-folders.db');
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const SQL = await initSqlJs({
    locateFile: (file: string) =>
      path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'sql.js', 'dist', file),
  });

  let db: SqlJsDatabase;
  if (fs.existsSync(resolvedPath)) {
    db = new SQL.Database(fs.readFileSync(resolvedPath));
  } else {
    db = new SQL.Database();
  }

  return new WatchedFolderStore(db, resolvedPath);
}

export function createWatchedFolderStore(
  db: SqlJsDatabase,
  dbPath?: string,
): WatchedFolderStore {
  return new WatchedFolderStore(db, dbPath ?? ':memory:');
}
