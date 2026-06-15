import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KeyStore } from '../../../extensions/pocketshell/src/backend/ssh/data/key-store';

const TEST_RSA_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAyKf7KmFm1CywFZtJ8q8r6g3HTW1ZlPDJYwMlb6UUqS0L5qXG
qP0m9YGEmhN7CkYqQ8qBXB3LhUJQJGPzU0qYD3WCxKrFvglLhFJQy5LzCQqJLVFg
-----END RSA PRIVATE KEY-----`;

const TEST_OPENSSH_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQy
NTUxOQAAACDRBdHzqP5UqH7yL2F7eQ8pTR6C7RN3VqvHqK5p7G7eF2l9NQoKPqYqNxE6UdCp
-----END OPENSSH PRIVATE KEY-----`;

const TEST_ENCRYPTED_KEY = `-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-256-CBC,ABCDEF0123456789

MIIEpAIBAAKCAQEAyKf7KmFm1CywFZtJ8q8r6g3HTW1ZlPDJYwMlb6UUqS0L5qXG
-----END RSA PRIVATE KEY-----`;

async function createTestDb(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();
  return new SQL.Database();
}

describe('extension KeyStore', () => {
  let keyStore: KeyStore;
  let tmpDir: string;
  let keysDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketshell-extension-key-store-'));
    keysDir = path.join(tmpDir, 'keys');
    keyStore = new KeyStore(await createTestDb(), ':memory:', keysDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imports, lists, and fetches key metadata', () => {
    const sourcePath = path.join(tmpDir, 'source-key');
    fs.writeFileSync(sourcePath, TEST_RSA_KEY, { mode: 0o600 });

    const key = keyStore.importKey('my key', sourcePath);

    expect(key.id).toBeGreaterThan(0);
    expect(key.name).toBe('my key');
    expect(key.hasPassphrase).toBe(false);
    expect(fs.existsSync(key.privateKeyPath)).toBe(true);
    expect(keyStore.list()).toHaveLength(1);
    expect(keyStore.get(key.id)?.id).toBe(key.id);
    expect(keyStore.getByPrivateKeyPath(key.privateKeyPath)?.id).toBe(key.id);
  });

  it('honors explicit passphrase metadata overrides', () => {
    const encryptedPath = path.join(tmpDir, 'encrypted-key');
    const plainPath = path.join(tmpDir, 'plain-key');
    fs.writeFileSync(encryptedPath, TEST_ENCRYPTED_KEY, { mode: 0o600 });
    fs.writeFileSync(plainPath, TEST_RSA_KEY, { mode: 0o600 });

    expect(keyStore.importKey('encrypted', encryptedPath, { hasPassphrase: false }).hasPassphrase).toBe(false);
    expect(keyStore.importKey('plain', plainPath, { hasPassphrase: true }).hasPassphrase).toBe(true);
  });

  it('uses unique managed paths for different keys with the same sanitized name', () => {
    const sourcePath1 = path.join(tmpDir, 'source-rsa');
    const sourcePath2 = path.join(tmpDir, 'source-openssh');
    fs.writeFileSync(sourcePath1, TEST_RSA_KEY, { mode: 0o600 });
    fs.writeFileSync(sourcePath2, TEST_OPENSSH_KEY, { mode: 0o600 });

    const key1 = keyStore.importKey('same name', sourcePath1);
    const key2 = keyStore.importKey('same name', sourcePath2);

    expect(path.basename(key1.privateKeyPath)).toBe('same_name');
    expect(path.basename(key2.privateKeyPath)).toBe('same_name-2');
    expect(fs.readFileSync(key1.privateKeyPath, 'utf-8')).toBe(TEST_RSA_KEY);
    expect(fs.readFileSync(key2.privateKeyPath, 'utf-8')).toBe(TEST_OPENSSH_KEY);
  });

  it('rejects passphrase-protected generation to avoid exposing secrets in argv', () => {
    expect(() => keyStore.generateKey('secret-key', 'super-secret')).toThrow(
      'Passphrase-protected key generation is not supported',
    );
    expect(keyStore.list()).toEqual([]);
  });
});
