/**
 * Installer for the extension-delta updater.
 *
 * Extracts a verified delta zip into a sibling directory then performs an
 * atomic rename swap with rollback. Pure backend logic: no `vscode` import.
 *
 * ZIP extraction is implemented in pure Node (parse the End-of-Central-Directory
 * record and central directory, inflate each entry with `node:zlib`'s
 * `inflateRaw`). No third-party zip dependency is required, so the canonical
 * `src/updates/` and the byte-identical extension mirror compile identically.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the target extension directory is not writable. Callers should
 * catch this and fall back to a manual update prompt.
 */
export class UpdatePermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdatePermissionError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of {@link installExtensionUpdate}. */
export interface InstallResult {
  ok: boolean;
  /** Path to the renamed-aside previous extension directory, on success. */
  backupPath?: string;
  /** Error message when `ok` is false. */
  error?: string;
}

// ---------------------------------------------------------------------------
// ZIP extraction (pure node, no deps)
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50; // End of central directory record
const SIG_CDH = 0x02014b50; // Central directory file header

function readUInt16LE(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}
function readUInt32LE(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

// CRC-32 (IEEE 802.3) table-based implementation, used to verify the integrity
// of stored (uncompressed) entries.
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
  /** CRC-32 of the uncompressed data, from the central directory. */
  crc32: number;
}

/**
 * Find the End-of-Central-Directory record and return its offset.
 *
 * The EOCD is near the end of the file; we scan the last 64KiB + header.
 */
function findEocdOffset(buf: Buffer): number {
  // EOCD is at least 22 bytes; comment can be up to 65535 bytes.
  const minEocd = 22;
  const maxBack = Math.min(buf.length, 65557);
  const startSearch = buf.length - maxBack;
  for (let i = buf.length - minEocd; i >= startSearch; i--) {
    if (readUInt32LE(buf, i) === SIG_EOCD) return i;
  }
  throw new Error('ZIP extraction failed: end-of-central-directory record not found');
}

/** Parse the central directory and return all file entries. */
function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEocdOffset(buf);
  const totalEntries = readUInt16LE(buf, eocd + 10);
  const cdOffset = readUInt32LE(buf, eocd + 16);

  const entries: ZipEntry[] = [];
  let off = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (readUInt32LE(buf, off) !== SIG_CDH) {
      throw new Error(`ZIP extraction failed: bad central directory header at ${off}`);
    }
    const compressionMethod = readUInt16LE(buf, off + 10);
    const crc32 = readUInt32LE(buf, off + 16);
    const compressedSize = readUInt32LE(buf, off + 20);
    const nameLen = readUInt16LE(buf, off + 28);
    const extraLen = readUInt16LE(buf, off + 30);
    const commentLen = readUInt16LE(buf, off + 32);
    const localHeaderOffset = readUInt32LE(buf, off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      localHeaderOffset,
      crc32,
    });

    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Read the raw compressed bytes for a single entry from its local header. */
function readEntryBytes(buf: Buffer, entry: ZipEntry): Buffer {
  const lh = entry.localHeaderOffset;
  if (readUInt32LE(buf, lh) !== 0x04034b50) {
    throw new Error(`ZIP extraction failed: bad local header at ${lh}`);
  }
  const nameLen = readUInt16LE(buf, lh + 26);
  const extraLen = readUInt16LE(buf, lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  return buf.subarray(dataStart, dataStart + entry.compressedSize);
}

/**
 * Extract a zip buffer into `destDir`. Directories (entries ending in `/`) are
 * created; file entries are inflated and written. No entry may escape `destDir`
 * via `..` or absolute paths (zip-slip protection).
 */
export function extractZipBuffer(buf: Buffer, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = readCentralDirectory(buf);

  for (const entry of entries) {
    // Robust zip-slip containment. We reject Windows drive-letter absolutes
    // (e.g. `C:\windows\win.ini`, `C:/evil`) explicitly because, on posix-node,
    // path.isAbsolute('C:\\...') is false and path.relative() would treat the
    // drive prefix as an ordinary relative segment. Then we resolve the entry
    // under destDir and assert the relative path stays strictly inside it:
    // this catches posix absolutes (`/etc/passwd`) and `..` traversal on every
    // platform.
    if (/^[A-Za-z]:/.test(entry.name)) {
      throw new Error(`zip-slip rejected: entry "${entry.name}" escapes destDir`);
    }
    const normalized = path.normalize(entry.name).replace(/\\/g, '/');
    const resolved = path.resolve(destDir, normalized);
    const rel = path.relative(destDir, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`zip-slip rejected: entry "${entry.name}" escapes destDir`);
    }
    const target = path.join(destDir, normalized);

    if (normalized.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const compressed = readEntryBytes(buf, entry);

    let bytes: Buffer;
    if (entry.compressionMethod === 0) {
      bytes = compressed; // stored, no compression
      // Deflate entries are decompressed by zlib, which itself detects
      // corruption. Stored entries bypass that, so we verify the CRC-32
      // (read from the central directory) against the uncompressed bytes to
      // catch tampering or truncation.
      if (crc32(bytes) !== entry.crc32) {
        throw new Error(
          `ZIP extraction failed: CRC mismatch for stored entry "${entry.name}"`,
        );
      }
    } else if (entry.compressionMethod === 8) {
      bytes = inflateRawSync(compressed); // deflate
    } else {
      throw new Error(
        `ZIP extraction failed: unsupported compression method ${entry.compressionMethod} for ${entry.name}`,
      );
    }
    fs.writeFileSync(target, bytes);
  }
}

// ---------------------------------------------------------------------------
// Atomic install + swap
// ---------------------------------------------------------------------------

/**
 * Install a verified delta zip over the existing extension directory.
 *
 * Steps:
 *   1. Pre-check that `targetDir` is writable (else throw
 *      {@link UpdatePermissionError}).
 *   2. Extract the zip into `<targetDir>.new`.
 *   3. Atomically swap: rename `targetDir` → `targetDir<backupSuffix|'.old'>`,
 *      then `<targetDir>.new` → `targetDir`.
 *   4. On ANY failure after the first rename, roll back (rename the backup back
 *      to `targetDir`) and rethrow.
 *
 * @param zipPath  Path to the already-downloaded, verified delta zip.
 * @param targetDir  The live extension directory (`context.extensionPath` at
 *   runtime — passed as a plain string here, no vscode).
 * @param opts.backupSuffix  Suffix for the renamed-aside old directory.
 *   Defaults to `.old`.
 */
export async function installExtensionUpdate(
  zipPath: string,
  targetDir: string,
  opts?: { backupSuffix?: string },
): Promise<InstallResult> {
  const suffix = opts?.backupSuffix ?? '.old';
  const stagingDir = `${targetDir}.new`;
  const backupPath = `${targetDir}${suffix}`;

  // 1. Writable pre-check.
  try {
    fs.accessSync(targetDir, fs.constants.W_OK);
  } catch {
    throw new UpdatePermissionError(
      `Extension directory is not writable: ${targetDir}`,
    );
  }

  // Clean up any stale staging/backup from a previous failed run.
  rmrfSync(stagingDir);
  rmrfSync(backupPath);

  // 2. Extract the zip into the staging directory. Clean up staging if the
  //    extraction fails so a later run does not see stale partial files.
  const zipBuf = fs.readFileSync(zipPath);
  try {
    extractZipBuffer(zipBuf, stagingDir);
  } catch (err) {
    rmrfSync(stagingDir);
    throw err;
  }

  // 3. Atomic swap with rollback. Both renames are guarded: if either fails we
  //    attempt to restore the previous extension directory from the backup so
  //    the running extension never disappears. If the first rename failed there
  //    is no backup to restore; if the second failed we rename the backup back.
  try {
    fs.renameSync(targetDir, backupPath);
    fs.renameSync(stagingDir, targetDir);
  } catch (err) {
    try {
      rmrfSync(stagingDir);
      // Restore the backup only if the live target is currently missing (i.e.
      // the first rename succeeded but the second did not).
      if (!fs.existsSync(targetDir) && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, targetDir);
      }
    } catch {
      // Swallow rollback errors; the original failure is surfaced below.
    }
    return { ok: false, error: `Atomic swap failed: ${errMsg(err)}` };
  }

  return { ok: true, backupPath };
}

/** Recursively remove a path if it exists (best-effort). */
function rmrfSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Best-effort; callers handle missing paths.
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
