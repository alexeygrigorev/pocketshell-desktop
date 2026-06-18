/**
 * Unit tests for src/updates/installer.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installExtensionUpdate, UpdatePermissionError, extractZipBuffer } from '../../../src/updates/installer';
import { ZipBuilder } from './zip-builder';

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

describe('extractZipBuffer', () => {
  let dest: string;
  beforeEach(() => {
    dest = makeTempDir('ext-');
  });
  afterEach(() => {
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('extracts stored and deflated entries with directory structure', async () => {
    const zip = new ZipBuilder()
      .dir('ext/')
      .store('ext/package.json', '{"name":"ext"}')
      .deflate('ext/main.js', 'console.log("hi");'.repeat(50))
      .dir('ext/sub/')
      .store('ext/sub/note.txt', 'nested')
      .build();

    await extractZipBuffer(zip, dest);

    expect(fs.readFileSync(path.join(dest, 'ext', 'package.json'), 'utf8')).toBe(
      '{"name":"ext"}',
    );
    expect(fs.readFileSync(path.join(dest, 'ext', 'main.js'), 'utf8')).toBe(
      'console.log("hi");'.repeat(50),
    );
    expect(fs.readFileSync(path.join(dest, 'ext', 'sub', 'note.txt'), 'utf8')).toBe(
      'nested',
    );
  });

  it('rejects a zip-slip entry traversing above the dest', async () => {
    const zip = new ZipBuilder().store('../escape.txt', 'evil').build();
    // The entry is rejected — by yauzl's filename validation at parse time
    // ("invalid relative path") or by the installer's write-site containment
    // ("zip-slip rejected"). Either layer escaping is enough; both must fire.
    await expect(extractZipBuffer(zip, dest)).rejects.toThrow(
      /zip-slip rejected|invalid relative path|absolute path/,
    );
  });

  it('rejects a Windows drive-letter absolute entry (backslash form)', async () => {
    const zip = new ZipBuilder().store('C:\\windows\\win.ini', 'evil').build();
    await expect(extractZipBuffer(zip, dest)).rejects.toThrow(
      /zip-slip rejected|invalid relative path|absolute path/,
    );
  });

  it('rejects a Windows drive-letter absolute entry (forward-slash form)', async () => {
    const zip = new ZipBuilder().store('C:/evil', 'evil').build();
    await expect(extractZipBuffer(zip, dest)).rejects.toThrow(
      /zip-slip rejected|invalid relative path|absolute path/,
    );
  });

  it('rejects a stored entry whose bytes do not match its header CRC-32', async () => {
    // Build a valid zip with one stored entry, then flip a payload byte so the
    // CRC-32 in the header no longer matches the actual (uncompressed) bytes.
    // yauzl does not validate the CRC of stored entries, so the installer
    // enforces it at the write site; this confirms that check still fires.
    const name = 'payload.txt';
    const zip = new ZipBuilder().store(name, 'hello world').build();

    // Local file header is 30 bytes; data follows the name. Flip the first
    // payload byte. We locate the local header by scanning for the signature
    // (robust against the builder's internal offset bookkeeping).
    const dataStart = findStoredDataOffset(zip, name);
    const tampered = Buffer.from(zip);
    tampered[dataStart] = (tampered[dataStart] + 1) & 0xff;
    await expect(extractZipBuffer(tampered, dest)).rejects.toThrow(/CRC mismatch/);
  });

  it('extracts a data-descriptor zip (CRC/sizes after the payload)', async () => {
    // A data-descriptor entry sets general-purpose bit 3 and writes the CRC,
    // compressed size, and uncompressed size in a trailing record AFTER the
    // file data rather than in the local file header. This layout was a known
    // gap of the previous hand-rolled reader; yauzl handles it natively.
    const zip = new ZipBuilder().storeDataDescriptor('dd.txt', 'descriptor body').build();
    await extractZipBuffer(zip, dest);
    expect(fs.readFileSync(path.join(dest, 'dd.txt'), 'utf8')).toBe(
      'descriptor body',
    );
  });
});

/**
 * Find the byte offset of the stored payload for `entryName` in a zip buffer.
 *
 * Walks the local file headers (signature 0x04034b50). Returns the offset of
 * the first data byte (right after the 30-byte local header + name length).
 * Used by the CRC-tamper test to corrupt a stored entry's bytes.
 */
function findStoredDataOffset(buf: Buffer, entryName: string): number {
  const nameBuf = Buffer.from(entryName, 'utf8');
  for (let i = 0; i + 30 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(i + 26);
    if (nameLen !== nameBuf.length) continue;
    const name = buf.subarray(i + 30, i + 30 + nameLen);
    if (Buffer.compare(name, nameBuf) !== 0) continue;
    return i + 30 + nameLen;
  }
  throw new Error(`test helper: entry "${entryName}" not found`);
}

describe('installExtensionUpdate', () => {
  let workDir: string;
  let targetDir: string;
  let zipPath: string;

  beforeEach(() => {
    workDir = makeTempDir('inst-');
    targetDir = path.join(workDir, 'extension');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'old.txt'), 'old contents');

    zipPath = path.join(workDir, 'delta.zip');
    const zip = new ZipBuilder()
      .store('package.json', '{"version":"0.1.4"}')
      .store('main.js', 'new code')
      .build();
    fs.writeFileSync(zipPath, zip);
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('performs the atomic swap and creates a backup', async () => {
    const result = await installExtensionUpdate(zipPath, targetDir);

    expect(result.ok).toBe(true);
    expect(result.backupPath).toBe(`${targetDir}.old`);

    // New contents are live at targetDir.
    expect(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8')).toBe(
      '{"version":"0.1.4"}',
    );
    expect(fs.readFileSync(path.join(targetDir, 'main.js'), 'utf8')).toBe('new code');

    // Old contents were moved to the backup.
    expect(fs.existsSync(result.backupPath)).toBe(true);
    expect(fs.readFileSync(path.join(result.backupPath!, 'old.txt'), 'utf8')).toBe(
      'old contents',
    );

    // Staging dir is gone.
    expect(fs.existsSync(`${targetDir}.new`)).toBe(false);
  });

  it('honors a custom backup suffix', async () => {
    const result = await installExtensionUpdate(zipPath, targetDir, {
      backupSuffix: '.bak',
    });
    expect(result.backupPath).toBe(`${targetDir}.bak`);
    expect(fs.existsSync(result.backupPath)).toBe(true);
  });

  it('throws UpdatePermissionError when the target is not writable', async () => {
    // Run only when unix perms are honored (root bypasses them).
    const isRoot = process.getuid && process.getuid() === 0;
    if (isRoot) return;

    // Create the target inside a parent, then make the target itself read-only.
    // fs.accessSync(targetDir, W_OK) must fail for the pre-check to throw.
    const roParent = path.join(workDir, 'ro');
    fs.mkdirSync(roParent, { recursive: true });
    const roTarget = path.join(roParent, 'ext');
    fs.mkdirSync(roTarget);
    fs.writeFileSync(path.join(roTarget, 'marker'), 'x');
    fs.chmodSync(roTarget, 0o555); // r-x: not writable

    try {
      await expect(installExtensionUpdate(zipPath, roTarget)).rejects.toBeInstanceOf(
        UpdatePermissionError,
      );
    } finally {
      fs.chmodSync(roTarget, 0o755); // restore so afterEach can clean up
    }
  });

  it('leaves the target intact when extraction fails (no swap performed)', async () => {
    // A corrupt zip makes extractZipBuffer throw AFTER the writable pre-check
    // passed but BEFORE any rename. The contract: original target untouched,
    // no staging/backup left behind.
    const badZip = path.join(workDir, 'bad.zip');
    fs.writeFileSync(badZip, Buffer.from('this is not a zip'));
    await expect(installExtensionUpdate(badZip, targetDir)).rejects.toThrow();

    expect(fs.existsSync(path.join(targetDir, 'old.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'old.txt'), 'utf8')).toBe(
      'old contents',
    );
    expect(fs.existsSync(`${targetDir}.new`)).toBe(false);
    expect(fs.existsSync(`${targetDir}.old`)).toBe(false);
  });

  it('leaves the live target intact if the swap cannot proceed (rollback)', async () => {
    // Run only when unix perms are honored (root bypasses them).
    const isRoot = process.getuid && process.getuid() === 0;
    if (isRoot) return;

    const sandbox = path.join(workDir, 'sandbox');
    fs.mkdirSync(sandbox, { recursive: true });
    const sandboxTarget = path.join(sandbox, 'extension');
    fs.mkdirSync(sandboxTarget);
    fs.writeFileSync(path.join(sandboxTarget, 'old.txt'), 'original');

    const sandboxZip = path.join(workDir, 'sb.zip');
    fs.writeFileSync(
      sandboxZip,
      new ZipBuilder().store('package.json', '{"version":"0.1.4"}').build(),
    );

    // Lock the sandbox parent so the install cannot complete the swap. The
    // contract under test: regardless of which step fails (staging creation or
    // the rename swap), the live extension directory is never corrupted and no
    // partial backup is left behind. A throw (extraction could not stage) is
    // also acceptable as long as the live target is intact.
    fs.chmodSync(sandbox, 0o555);
    try {
      let result: { ok: boolean; error?: string } | null = null;
      try {
        result = await installExtensionUpdate(sandboxZip, sandboxTarget);
      } catch {
        result = null; // staged throw is an acceptable failure mode
      }

      if (result && result.ok) {
        // Some filesystems permit renames within a read-only parent; in that
        // case the new contents are live and the backup holds the original.
        expect(fs.existsSync(`${sandboxTarget}.old`)).toBe(true);
      } else {
        // On the failure path (either a staged throw or ok:false) the live
        // target must be the original, untouched, with no backup left behind.
        expect(fs.existsSync(path.join(sandboxTarget, 'old.txt'))).toBe(true);
        expect(fs.readFileSync(path.join(sandboxTarget, 'old.txt'), 'utf8')).toBe(
          'original',
        );
        expect(fs.existsSync(`${sandboxTarget}.old`)).toBe(false);
      }
    } finally {
      fs.chmodSync(sandbox, 0o755);
    }
  });
});
