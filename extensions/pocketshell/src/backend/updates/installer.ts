/**
 * Installer for the extension-delta updater.
 *
 * Extracts a verified delta zip into a sibling directory then performs an
 * atomic rename swap with rollback. Pure backend logic: no `vscode` import.
 *
 * ZIP extraction uses `yauzl` — the same pure-JavaScript zip library VS Code
 * and npm use (no native binding, no system `unzip`/Python required). yauzl
 * handles data-descriptor and zip64 archives that the previous hand-rolled
 * reader could not. We layer our own zip-slip containment and stored-entry
 * CRC verification on top (yauzl validates sizes by default but does not
 * check the CRC-32 of stored, uncompressed entries), so the canonical
 * `src/updates/` and the byte-identical extension mirror compile identically.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';

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
// ZIP extraction (yauzl)
// ---------------------------------------------------------------------------

// CRC-32 (IEEE 802.3) table-based implementation. yauzl validates the sizes of
// entries (when validateEntrySizes is on, the default) and lets zlib catch
// corruption of deflated data, but it does NOT verify the CRC-32 of stored
// (uncompressed) entries — so we keep this check at the write site to preserve
// the integrity guarantee the previous hand-rolled reader enforced.
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

/** Open a yauzl ZipFile from a buffer (promise wrapper around fromBuffer). */
function openZip(buf: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    // lazyEntries: true so we drive iteration via readEntry() and can apply our
    // containment check before reading any entry's bytes. validateEntrySizes
    // is on by default; decodeStrings is on by default (entry names are utf8).
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) reject(err ?? new Error('yauzl: failed to open zip'));
      else resolve(zipfile);
    });
  });
}

/** Read a single entry's decompressed bytes into a Buffer. */
function readEntryBytes(zipfile: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('yauzl: failed to open read stream'));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

/**
 * Extract a zip buffer into `destDir`. Directories (entries whose name ends in
 * `/`) are created; file entries are read via yauzl and written. No entry may
 * escape `destDir` via `..` or absolute paths (zip-slip protection). Async
 * because yauzl is callback/stream based.
 */
export async function extractZipBuffer(buf: Buffer, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const zipfile = await openZip(buf);

  await new Promise<void>((resolve, reject) => {
    zipfile.on('error', reject);

    zipfile.on('entry', (entry: Entry) => {
      // Robust zip-slip containment. We reject Windows drive-letter absolutes
      // Robust zip-slip containment. We reject Windows drive-letter absolutes
      // (e.g. `C:\windows\win.ini`, `C:/evil`) explicitly because, on posix-node,
      // path.isAbsolute('C:\\...') is false and path.relative() would treat the
      // drive prefix as an ordinary relative segment. Then we resolve the entry
      // under destDir and assert the relative path stays strictly inside it:
      // this catches posix absolutes (`/etc/passwd`) and `..` traversal on every
      // platform.
      const name = entry.fileName;
      if (/^[A-Za-z]:/.test(name)) {
        reject(new Error(`zip-slip rejected: entry "${name}" escapes destDir`));
        zipfile.close();
        return;
      }
      const normalized = path.normalize(name).replace(/\\/g, '/');
      const resolved = path.resolve(destDir, normalized);
      const rel = path.relative(destDir, resolved);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        reject(new Error(`zip-slip rejected: entry "${name}" escapes destDir`));
        zipfile.close();
        return;
      }
      const target = path.join(destDir, normalized);

      if (normalized.endsWith('/')) {
        // Directory entry.
        fs.mkdirSync(target, { recursive: true });
        zipfile.readEntry();
        return;
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });

      // Read the decompressed bytes then verify the stored-entry CRC-32. yauzl
      // validates sizes and lets zlib catch deflate corruption, but it does not
      // verify the CRC of stored (uncompressed) entries, so we enforce it here
      // to preserve the integrity guarantee (this also covers deflated entries,
      // which is a stricter check than yauzl alone).
      readEntryBytes(zipfile, entry)
        .then((bytes) => {
          if (crc32(bytes) !== entry.crc32) {
            throw new Error(
              `ZIP extraction failed: CRC mismatch for stored entry "${name}"`,
            );
          }
          fs.writeFileSync(target, bytes);
          zipfile.readEntry();
        })
        .catch((err) => {
          zipfile.close();
          reject(err);
        });
    });

    zipfile.on('end', resolve);

    // With lazyEntries: true, yauzl does not emit the first entry automatically;
    // kick off iteration once the listeners above are registered.
    zipfile.readEntry();
  });
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
    await extractZipBuffer(zipBuf, stagingDir);
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
