/**
 * Unit tests for KeyStore.
 *
 * Uses in-memory SQLite and a temp directory for key files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  KeyStore,
  computeFingerprint,
  looksLikePrivateKey,
  hasPrivateKeyPassphrase,
} from '../../../src/ssh/data/key-store';

const TEST_RSA_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAyKf7KmFm1CywFZtJ8q8r6g3HTW1ZlPDJYwMlb6UUqS0L5qXG
qP0m9YGEmhN7CkYqQ8qBXB3LhUJQJGPzU0qYD3WCxKrFvglLhFJQy5LzCQqJLVFg
HZ8kQBqPKjiFJOKuFKzE0HiYqBf2C+pLbN4Y5gLvKl0pYzF4YR3kYQ8aP7G7eF2l
9NQoKPqYqNxE6UdCpBpKQ5TLdFn4R9eY0YVfHqTJdQmN2K3QP5UqH7yL2F7eQ8p
TR6C7RN3VqvHqK5p7G7eF2l9NQoKPqYqNxE6UdCpBpKQ5TLdFn4R9eY0YVfHqTJd
QmN2K3QP5UqH7yL2F7eQ8pTR6C7RN3VqvHqK5p7G7eF2l9NQoKPqYqNxE6UdCpBp
KQ5TLdFn4R9eY0YVfHqTJdQmN2K3Q5TLdFn4R9eY0YVfHqTJdQmN2K3Q5TLdFn4
R9eY0YVfHqTJdQmN2K3QP5UqH7yL2F7eQ8pTR6C7RN3VqvHqK5p7G7eF2l9NQoK
PqYqNxE6UdCpBpKQ5TLdFn4R9eY0YVfHqTJdQmN2K3QP5UqH7yL2F7eQ8pTR6C7
RN3VqvHqK5p7G7eF2l9NQoKPqYqNxE6UdCpBpKQ5TLdFn4R9eY0YVfHqTJdQmN2
K3QP5UqH7yL2F7eQ8pTR6C7RN3VqvHqK5p7G7eF2l9NQoKPqYqNxE6UdCpBpKQ5
TLdFn4R9eY0YVfHqTJdQmN2K3QP5UqH7yL2F7eQ8pTR6C7RN3VqvHqK5p7G7eF2
l9NQoKPqYqNxE6UdCpBpKQ5TLdFn4R9eY0YVfHqTJdQmN2K3QP5UqH7yL2F7eQ8
pTR6C7RN3VqvHqK5p7G7eF2l9NQoKPqYqNxE6UdCpBpKQ5TLdFn4R9eY0YVfHqTJ
dQmN2K3QP5UqH7yL2F7eQ8pTR6C7RN3VqvHqK5p7G7eF2l9NQoKPqYqNxE6UdCp
BpKQ5TLdFn4R9eY0YVfHqTJdQmN2K3QP5UqH7yL2F7eQ8pTR6C7RN3VqvHqK5p7
-----END RSA PRIVATE KEY-----`;

const TEST_OPENSSH_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQy
NTUxOQAAACDRBdHzqP5UqH7yL2F7eQ8pTR6C7RN3VqvHqK5p7G7eF2l9NQoKPqYqNxE6UdCp
BpKQ5TLdFn4R9eY0YVfHqTJdQmN2K3QP5UqH7yL2F7eQ8pTR6C7RN3VqvHqK5p7G7eF2l9
NQoKPqYqNxE6UdCpBpKQ5TLdFn4R9eY0YVfHqTJdQmN2K3QP5UqH7yL2F7eQ8pTR6C7RN3
VqvHqK5p7G7eF2l9NQoKPqYqNxE6UdCpBpKQ5TLdFn4R9eY0YVfHqTJdQmN2K3Q5TLdFn4
-----END OPENSSH PRIVATE KEY-----`;

const TEST_ENCRYPTED_KEY = `-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-256-CBC,ABCDEF0123456789

MIIEpAIBAAKCAQEAyKf7KmFm1CywFZtJ8q8r6g3HTW1ZlPDJYwMlb6UUqS0L5qXG
qP0m9YGEmhN7CkYqQ8qBXB3LhUJQJGPzU0qYD3WCxKrFvglLhFJQy5LzCQqJLVFg
-----END RSA PRIVATE KEY-----`;

describe('KeyStore', () => {
  let db: Database.Database;
  let keyStore: KeyStore;
  let tmpDir: string;
  let keysDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketshell-test-'));
    keysDir = path.join(tmpDir, 'keys');

    keyStore = new KeyStore(db, keysDir);
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('empty store', () => {
    it('returns empty array when no keys exist', () => {
      expect(keyStore.list()).toEqual([]);
    });

    it('returns undefined for non-existent key', () => {
      expect(keyStore.get(999)).toBeUndefined();
    });

    it('returns undefined for non-existent fingerprint', () => {
      expect(keyStore.getByFingerprint('sha256:nope')).toBeUndefined();
    });
  });

  describe('importKey', () => {
    it('imports a key from a file', () => {
      const sourcePath = path.join(tmpDir, 'source-key');
      fs.writeFileSync(sourcePath, TEST_RSA_KEY, { mode: 0o600 });

      const key = keyStore.importKey('my-key', sourcePath);

      expect(key.id).toBeGreaterThan(0);
      expect(key.name).toBe('my-key');
      expect(key.fingerprint).toMatch(/^sha256:/);
      expect(key.hasPassphrase).toBe(false);
      expect(key.createdAt).toBeGreaterThan(0);

      // Key file should be copied to keysDir
      expect(fs.existsSync(key.privateKeyPath)).toBe(true);
      expect(key.privateKeyPath).toContain('keys');
    });

    it('deduplicates by fingerprint', () => {
      const sourcePath = path.join(tmpDir, 'source-key');
      fs.writeFileSync(sourcePath, TEST_RSA_KEY, { mode: 0o600 });

      const key1 = keyStore.importKey('first', sourcePath);
      const key2 = keyStore.importKey('second', sourcePath);

      // Should return the same key (by id), not create a duplicate
      expect(key2.id).toBe(key1.id);
      expect(keyStore.list()).toHaveLength(1);
    });

    it('throws for non-key file', () => {
      const sourcePath = path.join(tmpDir, 'not-a-key');
      fs.writeFileSync(sourcePath, 'this is not a key');

      expect(() => keyStore.importKey('bad', sourcePath)).toThrow(
        'does not look like a private key',
      );
    });

    it('detects passphrase from content', () => {
      const sourcePath = path.join(tmpDir, 'encrypted-key');
      fs.writeFileSync(sourcePath, TEST_ENCRYPTED_KEY, { mode: 0o600 });

      const key = keyStore.importKey('encrypted', sourcePath);
      expect(key.hasPassphrase).toBe(true);
    });

    it('imports OpenSSH format keys', () => {
      const sourcePath = path.join(tmpDir, 'openssh-key');
      fs.writeFileSync(sourcePath, TEST_OPENSSH_KEY, { mode: 0o600 });

      const key = keyStore.importKey('openssh', sourcePath);
      expect(key.id).toBeGreaterThan(0);
      expect(key.fingerprint).toMatch(/^sha256:/);
    });
  });

  describe('list', () => {
    it('returns keys ordered by name', () => {
      const sourcePath1 = path.join(tmpDir, 'key-z');
      fs.writeFileSync(sourcePath1, TEST_RSA_KEY, { mode: 0o600 });

      const sourcePath2 = path.join(tmpDir, 'key-a');
      fs.writeFileSync(sourcePath2, TEST_OPENSSH_KEY, { mode: 0o600 });

      keyStore.importKey('z-key', sourcePath1);
      keyStore.importKey('a-key', sourcePath2);

      const keys = keyStore.list();
      expect(keys).toHaveLength(2);
      expect(keys[0].name).toBe('a-key');
      expect(keys[1].name).toBe('z-key');
    });
  });

  describe('get', () => {
    it('returns key by id', () => {
      const sourcePath = path.join(tmpDir, 'get-key');
      fs.writeFileSync(sourcePath, TEST_RSA_KEY, { mode: 0o600 });

      const imported = keyStore.importKey('get-key', sourcePath);
      const fetched = keyStore.get(imported.id);

      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(imported.id);
      expect(fetched!.name).toBe('get-key');
    });
  });

  describe('getByFingerprint', () => {
    it('returns key by fingerprint', () => {
      const sourcePath = path.join(tmpDir, 'fp-key');
      fs.writeFileSync(sourcePath, TEST_RSA_KEY, { mode: 0o600 });

      const imported = keyStore.importKey('fp-key', sourcePath);
      const fetched = keyStore.getByFingerprint(imported.fingerprint);

      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(imported.id);
    });
  });

  describe('remove', () => {
    it('removes a key and its file', () => {
      const sourcePath = path.join(tmpDir, 'rm-key');
      fs.writeFileSync(sourcePath, TEST_RSA_KEY, { mode: 0o600 });

      const imported = keyStore.importKey('rm-key', sourcePath);
      const keyPath = imported.privateKeyPath;

      expect(fs.existsSync(keyPath)).toBe(true);

      const removed = keyStore.remove(imported.id);
      expect(removed).toBe(true);
      expect(keyStore.get(imported.id)).toBeUndefined();
      expect(fs.existsSync(keyPath)).toBe(false);
    });

    it('returns false for non-existent key', () => {
      expect(keyStore.remove(999)).toBe(false);
    });
  });
});

describe('computeFingerprint', () => {
  it('produces sha256:<base64> format', () => {
    const fp = computeFingerprint(TEST_RSA_KEY);
    expect(fp).toMatch(/^sha256:[A-Za-z0-9+/=]+$/);
  });

  it('produces different fingerprints for different keys', () => {
    const fp1 = computeFingerprint(TEST_RSA_KEY);
    const fp2 = computeFingerprint(TEST_OPENSSH_KEY);
    expect(fp1).not.toBe(fp2);
  });

  it('produces same fingerprint for same key regardless of trailing whitespace', () => {
    const fp1 = computeFingerprint(TEST_RSA_KEY);
    const fp2 = computeFingerprint(TEST_RSA_KEY + '\n\n\n');
    expect(fp1).toBe(fp2);
  });
});

describe('looksLikePrivateKey', () => {
  it('recognizes RSA private keys', () => {
    expect(looksLikePrivateKey(TEST_RSA_KEY)).toBe(true);
  });

  it('recognizes OpenSSH private keys', () => {
    expect(looksLikePrivateKey(TEST_OPENSSH_KEY)).toBe(true);
  });

  it('recognizes encrypted private keys', () => {
    expect(looksLikePrivateKey(TEST_ENCRYPTED_KEY)).toBe(true);
  });

  it('rejects non-key content', () => {
    expect(looksLikePrivateKey('hello world')).toBe(false);
    expect(looksLikePrivateKey('')).toBe(false);
    expect(looksLikePrivateKey('-----BEGIN PUBLIC KEY-----\nstuff\n-----END PUBLIC KEY-----')).toBe(false);
  });
});

describe('hasPrivateKeyPassphrase', () => {
  it('detects Proc-Type: 4,ENCRYPTED', () => {
    expect(hasPrivateKeyPassphrase(TEST_ENCRYPTED_KEY)).toBe(true);
  });

  it('detects ENCRYPTED PRIVATE KEY', () => {
    const key = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nstuff\n-----END ENCRYPTED PRIVATE KEY-----';
    expect(hasPrivateKeyPassphrase(key)).toBe(true);
  });

  it('returns false for unencrypted keys', () => {
    expect(hasPrivateKeyPassphrase(TEST_RSA_KEY)).toBe(false);
    expect(hasPrivateKeyPassphrase(TEST_OPENSSH_KEY)).toBe(false);
  });
});
