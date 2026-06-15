/**
 * SSH key management for PocketShell Desktop.
 *
 * Stores SSH key metadata in SQLite and manages key files on disk.
 * Key files are stored in `~/.pocketshell/keys/`.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** SSH key metadata stored in the `ssh_keys` table. */
export interface SshKey {
  id: number;
  name: string;
  privateKeyPath: string;
  fingerprint: string; // "sha256:<hex>"
  hasPassphrase: boolean;
  createdAt: number; // epoch ms
}

/** Fields required when adding a new key. */
export type NewSshKey = Omit<SshKey, 'id' | 'createdAt'>;

export interface ImportKeyOptions {
  hasPassphrase?: boolean;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface SshKeyRow {
  id: number;
  name: string;
  private_key_path: string;
  fingerprint: string;
  has_passphrase: number;
  created_at: number;
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

// ---------------------------------------------------------------------------
// Key utilities
// ---------------------------------------------------------------------------

/** Default directory where imported/generated keys are stored. */
export function defaultKeysDir(): string {
  return path.join(os.homedir(), '.pocketshell', 'keys');
}

/**
 * Compute SHA-256 fingerprint of a private key's content.
 * Returns `"sha256:<base64>"` format (matching OpenSSH).
 */
export function computeFingerprint(keyContent: string): string {
  // Trim trailing whitespace / newlines before hashing
  const trimmed = keyContent.replace(/\s+$/, '');
  const hash = crypto.createHash('sha256').update(trimmed).digest('base64');
  return `sha256:${hash}`;
}

/**
 * Check whether a string looks like a PEM/OpenSSH private key.
 */
export function looksLikePrivateKey(content: string): boolean {
  return /-----BEGIN[\sA-Z]*PRIVATE KEY-----/.test(content) &&
         /-----END[\sA-Z]*PRIVATE KEY-----/.test(content);
}

/**
 * Heuristic check for whether a private key is encrypted (has a passphrase).
 */
export function hasPrivateKeyPassphrase(content: string): boolean {
  if (/Proc-Type:.*ENCRYPTED/i.test(content)) return true;
  if (/DEK-Info:/i.test(content)) return true;
  if (/BEGIN ENCRYPTED PRIVATE KEY/.test(content)) return true;
  if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(content)) {
    return hasEncryptedOpenSshPrivateKeyPayload(content);
  }
  return false;
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
    if (cipherNameEnd > payload.length) {
      return false;
    }

    const cipherName = payload.subarray(cipherNameStart, cipherNameEnd).toString('utf-8');
    return cipherName !== '' && cipherName !== 'none';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// KeyStore class
// ---------------------------------------------------------------------------

export class KeyStore {
  private keysDir: string;

  constructor(
    private db: Database.Database,
    keysDirOverride?: string,
  ) {
    this.keysDir = keysDirOverride ?? defaultKeysDir();
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLE_SQL);
  }

  /** Return all keys ordered by name. */
  list(): SshKey[] {
    const rows = this.db
      .prepare(`SELECT * FROM ssh_keys ORDER BY name`)
      .all() as SshKeyRow[];
    return rows.map(rowToSshKey);
  }

  /** Return a single key by id, or undefined if not found. */
  get(id: number): SshKey | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ssh_keys WHERE id = ?`)
      .get(id) as SshKeyRow | undefined;
    return row ? rowToSshKey(row) : undefined;
  }

  /** Return a key by fingerprint, or undefined if not found. */
  getByFingerprint(fingerprint: string): SshKey | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ssh_keys WHERE fingerprint = ? ORDER BY id LIMIT 1`)
      .get(fingerprint) as SshKeyRow | undefined;
    return row ? rowToSshKey(row) : undefined;
  }

  /**
   * Import an SSH private key.
   *
   * Copies the key file to `~/.pocketshell/keys/<name>`, computes its
   * fingerprint, and stores the metadata. If a key with the same fingerprint
   * already exists, returns the existing entry (dedup).
   */
  importKey(
    name: string,
    sourcePath: string,
    options?: ImportKeyOptions | string,
  ): SshKey {
    const content = fs.readFileSync(sourcePath, 'utf-8');

    if (!looksLikePrivateKey(content)) {
      throw new Error(`File does not look like a private key: ${sourcePath}`);
    }

    const fingerprint = computeFingerprint(content);

    // Dedup: if a key with this fingerprint already exists, return it
    const existing = this.getByFingerprint(fingerprint);
    if (existing) {
      return existing;
    }

    const hasPassphrase = resolveImportHasPassphrase(content, options);

    // Ensure keys directory exists
    fs.mkdirSync(this.keysDir, { recursive: true });

    // Write key to managed location
    const destPath = uniqueKeyPath(this.keysDir, sanitizeFilename(name));
    fs.writeFileSync(destPath, content, { mode: 0o600 });

    const id = this.insertRecord(name, destPath, fingerprint, hasPassphrase);
    return this.get(id)!;
  }

  /**
   * Generate a new SSH keypair.
   *
   * Uses `ssh-keygen` via child process. The private key is stored in
   * `~/.pocketshell/keys/<name>`.
   *
   * @param name - Display name and filename for the key.
   * @param type - Key type (e.g. "rsa", "ed25519"). Defaults to "ed25519".
   * @param bits - Key size in bits (for RSA). Defaults to 3072.
   * @param passphrase - Unsupported. Passphrase-protected generated keys are
   *   intentionally rejected to avoid exposing secrets through ssh-keygen argv.
   */
  generateKey(
    name: string,
    type: string = 'ed25519',
    bits: number = 3072,
    passphrase?: string,
  ): SshKey {
    if (passphrase !== undefined && passphrase.length > 0) {
      throw new Error('Passphrase-protected key generation is not supported; import an encrypted key instead');
    }

    fs.mkdirSync(this.keysDir, { recursive: true });

    const filename = sanitizeFilename(name);
    const keyPath = uniqueKeyPath(this.keysDir, filename);

    const args: string[] = ['-t', type, '-f', keyPath, '-N', ''];

    if (type === 'rsa') {
      args.push('-b', String(bits));
    }

    // ssh-keygen writes a comment by default; set an explicit one
    args.push('-C', name);

    try {
      execFileSync('ssh-keygen', args, { timeout: 30_000 });
    } catch (err: any) {
      throw new Error(`ssh-keygen failed: ${err.message}`);
    }

    // Read back the private key content for fingerprinting
    const content = fs.readFileSync(keyPath, 'utf-8');
    const fingerprint = computeFingerprint(content);

    const id = this.insertRecord(
      name,
      keyPath,
      fingerprint,
      passphrase !== undefined && passphrase.length > 0,
    );

    // Remove the public key file (we don't need it stored locally)
    const pubPath = `${keyPath}.pub`;
    if (fs.existsSync(pubPath)) {
      fs.unlinkSync(pubPath);
    }

    return this.get(id)!;
  }

  /** Remove a key by id. Deletes the key file and the database row. */
  remove(id: number): boolean {
    const key = this.get(id);
    if (!key) return false;

    // Delete file first
    try {
      if (fs.existsSync(key.privateKeyPath)) {
        fs.unlinkSync(key.privateKeyPath);
      }
    } catch {
      // Swallow file deletion errors — the DB row is still removed.
    }

    const result = this.db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // -- Private helpers -----------------------------------------------------

  private insertRecord(
    name: string,
    destPath: string,
    fingerprint: string,
    hasPassphrase: boolean,
  ): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO ssh_keys (name, private_key_path, fingerprint, has_passphrase, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(name, destPath, fingerprint, hasPassphrase ? 1 : 0, now);
    return Number(result.lastInsertRowid);
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the key store.
 *
 * @param db - A `better-sqlite3` database instance (shared with host-store).
 * @param keysDir - Override for the directory where key files are stored.
 */
export function initKeyStore(db: Database.Database, keysDir?: string): KeyStore {
  db.exec(CREATE_TABLE_SQL);
  return new KeyStore(db, keysDir);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
