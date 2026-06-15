/**
 * sql.js-backed SSH key metadata store for the VS Code extension runtime.
 *
 * This mirrors the core KeyStore behavior without better-sqlite3 so the
 * extension host does not need a native SQLite module.
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SshKey {
  id: number;
  name: string;
  privateKeyPath: string;
  fingerprint: string;
  hasPassphrase: boolean;
  createdAt: number;
}

export type NewSshKey = Omit<SshKey, 'id' | 'createdAt'>;

export interface ImportKeyOptions {
  hasPassphrase?: boolean;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ssh_keys (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  private_key_path  TEXT NOT NULL,
  fingerprint       TEXT NOT NULL DEFAULT '',
  has_passphrase    INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
`;

interface SshKeyRow {
  id: number;
  name: string;
  private_key_path: string;
  fingerprint: string;
  has_passphrase: number;
  created_at: number;
}

export function defaultKeysDir(storageDir?: string): string {
  return storageDir ? path.join(storageDir, 'keys') : path.join(os.homedir(), '.pocketshell', 'keys');
}

export function computeFingerprint(keyContent: string): string {
  const trimmed = keyContent.replace(/\s+$/, '');
  const hash = crypto.createHash('sha256').update(trimmed).digest('base64');
  return `sha256:${hash}`;
}

export function looksLikePrivateKey(content: string): boolean {
  return /-----BEGIN[\sA-Z]*PRIVATE KEY-----/.test(content) &&
    /-----END[\sA-Z]*PRIVATE KEY-----/.test(content);
}

export function hasPrivateKeyPassphrase(content: string): boolean {
  if (/Proc-Type:.*ENCRYPTED/i.test(content)) return true;
  if (/DEK-Info:/i.test(content)) return true;
  if (/BEGIN ENCRYPTED PRIVATE KEY/.test(content)) return true;
  if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(content)) {
    return hasEncryptedOpenSshPrivateKeyPayload(content);
  }
  return false;
}

export class KeyStore {
  constructor(
    private db: SqlJsDatabase,
    private dbPath: string,
    private keysDir: string,
  ) {
    this.db.run(CREATE_TABLE_SQL);
  }

  list(): SshKey[] {
    const results = this.db.exec('SELECT * FROM ssh_keys ORDER BY name');
    if (results.length === 0) return [];
    const cols = results[0].columns;
    return results[0].values.map(row => rowToSshKey(mapRow(cols, row)));
  }

  get(id: number): SshKey | undefined {
    const stmt = this.db.prepare('SELECT * FROM ssh_keys WHERE id = ?');
    stmt.bind([id]);
    try {
      if (!stmt.step()) return undefined;
      return rowToSshKey(mapRow(stmt.getColumnNames(), stmt.get()));
    } finally {
      stmt.free();
    }
  }

  getByFingerprint(fingerprint: string): SshKey | undefined {
    const stmt = this.db.prepare('SELECT * FROM ssh_keys WHERE fingerprint = ? ORDER BY id LIMIT 1');
    stmt.bind([fingerprint]);
    try {
      if (!stmt.step()) return undefined;
      return rowToSshKey(mapRow(stmt.getColumnNames(), stmt.get()));
    } finally {
      stmt.free();
    }
  }

  getByPrivateKeyPath(privateKeyPath: string): SshKey | undefined {
    const stmt = this.db.prepare('SELECT * FROM ssh_keys WHERE private_key_path = ? ORDER BY id LIMIT 1');
    stmt.bind([privateKeyPath]);
    try {
      if (!stmt.step()) return undefined;
      return rowToSshKey(mapRow(stmt.getColumnNames(), stmt.get()));
    } finally {
      stmt.free();
    }
  }

  importKey(name: string, sourcePath: string, options?: ImportKeyOptions | string): SshKey {
    const content = fs.readFileSync(sourcePath, 'utf-8');
    if (!looksLikePrivateKey(content)) {
      throw new Error(`File does not look like a private key: ${sourcePath}`);
    }

    const fingerprint = computeFingerprint(content);
    const existing = this.getByFingerprint(fingerprint);
    if (existing) return existing;

    fs.mkdirSync(this.keysDir, { recursive: true });
    const destPath = uniqueKeyPath(this.keysDir, sanitizeFilename(name));
    fs.writeFileSync(destPath, content, { mode: 0o600 });

    const id = this.insertRecord(
      name,
      destPath,
      fingerprint,
      resolveImportHasPassphrase(content, options),
    );
    this.save();
    return this.get(id)!;
  }

  generateKey(name: string, passphrase?: string): SshKey {
    if (passphrase !== undefined && passphrase.length > 0) {
      throw new Error('Passphrase-protected key generation is not supported; import an encrypted key instead');
    }

    fs.mkdirSync(this.keysDir, { recursive: true });
    const keyPath = uniqueKeyPath(this.keysDir, sanitizeFilename(name));
    const args = ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', name];

    try {
      execFileSync('ssh-keygen', args, { timeout: 30_000 });
    } catch (err: any) {
      throw new Error(`ssh-keygen failed: ${err.message}`);
    }

    const pubPath = `${keyPath}.pub`;
    if (fs.existsSync(pubPath)) {
      fs.unlinkSync(pubPath);
    }

    const content = fs.readFileSync(keyPath, 'utf-8');
    const id = this.insertRecord(
      name,
      keyPath,
      computeFingerprint(content),
      false,
    );
    this.save();
    return this.get(id)!;
  }

  private insertRecord(name: string, privateKeyPath: string, fingerprint: string, hasPassphrase: boolean): number {
    this.db.run(
      `INSERT INTO ssh_keys (name, private_key_path, fingerprint, has_passphrase, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [name, privateKeyPath, fingerprint, hasPassphrase ? 1 : 0, Date.now()],
    );
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    return result[0].values[0][0] as number;
  }

  private save(): void {
    if (this.dbPath === ':memory:') return;
    fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }
}

export async function initKeyStore(dbPath: string, keysDir: string): Promise<KeyStore> {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(keysDir, { recursive: true });

  const SQL = await initSqlJs({
    locateFile: (file: string) =>
      path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'sql.js', 'dist', file),
  });

  const db = fs.existsSync(dbPath)
    ? new SQL.Database(fs.readFileSync(dbPath))
    : new SQL.Database();
  return new KeyStore(db, dbPath, keysDir);
}

function rowToSshKey(row: SshKeyRow): SshKey {
  return {
    id: row.id,
    name: row.name,
    privateKeyPath: row.private_key_path,
    fingerprint: row.fingerprint,
    hasPassphrase: row.has_passphrase !== 0,
    createdAt: row.created_at,
  };
}

function mapRow(columns: string[], values: (string | number | null | Uint8Array)[]): SshKeyRow {
  const obj: Record<string, string | number | null | Uint8Array> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = values[i];
  }
  return obj as unknown as SshKeyRow;
}

function sanitizeFilename(name: string): string {
  return (name.trim() || 'id_ed25519').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function uniqueKeyPath(dir: string, filename: string): string {
  let candidate = path.join(dir, filename);
  if (!fs.existsSync(candidate)) return candidate;

  const ext = path.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  let suffix = 2;
  do {
    candidate = path.join(dir, `${base}-${suffix}${ext}`);
    suffix += 1;
  } while (fs.existsSync(candidate));
  return candidate;
}

function resolveImportHasPassphrase(content: string, options?: ImportKeyOptions | string): boolean {
  if (typeof options === 'string') {
    return true;
  }
  if (options?.hasPassphrase !== undefined) {
    return options.hasPassphrase;
  }
  return hasPrivateKeyPassphrase(content);
}

function hasEncryptedOpenSshPrivateKeyPayload(content: string): boolean {
  const body = content
    .replace(/-----BEGIN OPENSSH PRIVATE KEY-----/g, '')
    .replace(/-----END OPENSSH PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  try {
    const payload = Buffer.from(body, 'base64');
    const magic = Buffer.from('openssh-key-v1\0', 'utf-8');
    if (payload.length < magic.length + 4 || !payload.subarray(0, magic.length).equals(magic)) {
      return false;
    }

    const cipherNameLength = payload.readUInt32BE(magic.length);
    const cipherNameStart = magic.length + 4;
    const cipherNameEnd = cipherNameStart + cipherNameLength;
    if (cipherNameEnd > payload.length) return false;
    const cipherName = payload.subarray(cipherNameStart, cipherNameEnd).toString('utf-8');
    return cipherName !== '' && cipherName !== 'none';
  } catch {
    return false;
  }
}
