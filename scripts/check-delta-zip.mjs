// Portable, dependency-free validator for the extension-delta zip produced by
// .github/workflows/release.yml.
//
// Replaces the previous `unzip -Z1 | grep` assertion. `unzip` is NOT guaranteed
// on the windows-2022 runner's Git-Bash, so the old check silently no-oped on
// Windows and a nested zip could ship undetected and corrupt every Windows
// install. Node IS guaranteed on all three runners (the workflow requires it),
// so this check is portable.
//
// Unlike the old check, this asserts BOTH directions:
//   - POSITIVE: every required top-level entry is present
//     (out/extension.js, package.json, base-version.json)
//   - NEGATIVE: no entry path starts with `pocketshell/` (nested layout would
//     break the installer, which extracts entries with no parent-dir stripping)
//
// Usage: node scripts/check-delta-zip.mjs <path-to-delta.zip>
// Exit 0 + "zip-ok: <N> entries" on success, exit 1 with a clear message on
// failure.
//
// The central-directory reader is a trimmed, read-only version of the one in
// extensions/pocketshell/src/backend/updates/installer.ts (only entry names are
// needed here; nothing is decompressed).

import * as fs from 'node:fs';

const SIG_EOCD = 0x06054b50; // End of central directory record
const SIG_CDH = 0x02014b50; // Central directory file header

function findEocdOffset(buf) {
  // EOCD is at least 22 bytes; trailing comment can be up to 65535 bytes.
  const minEocd = 22;
  const maxBack = Math.min(buf.length, 65557);
  const startSearch = buf.length - maxBack;
  for (let i = buf.length - minEocd; i >= startSearch; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('end-of-central-directory record not found');
}

/** Parse the central directory and return all entry names. */
function readEntryNames(buf) {
  const eocd = findEocdOffset(buf);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const names = [];
  let off = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(off) !== SIG_CDH) {
      throw new Error(`bad central directory header at ${off}`);
    }
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    names.push(name);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

const zipPath = process.argv[2];
if (!zipPath) {
  fail('usage: node scripts/check-delta-zip.mjs <path-to-delta.zip>');
}

let buf;
try {
  buf = fs.readFileSync(zipPath);
} catch (err) {
  fail(`could not read zip "${zipPath}": ${err.message}`);
}

let names;
try {
  names = readEntryNames(buf);
} catch (err) {
  fail(`could not parse zip central directory: ${err.message}`);
}

// The updater's installer extracts entries directly over context.extensionPath
// with no parent-dir stripping. The delta zip MUST be flat (entries at the
// extension root) and MUST contain the entries the updater/runtime depend on.
const REQUIRED = ['out/extension.js', 'package.json', 'base-version.json'];

const present = new Set(names);

const missing = REQUIRED.filter((n) => !present.has(n));
if (missing.length > 0) {
  fail(
    `delta zip is missing required entries: ${missing.join(', ')}. ` +
      `Required: ${REQUIRED.join(', ')}.`,
  );
}

const nested = names.filter((n) => n.startsWith('pocketshell/'));
if (nested.length > 0) {
  fail(
    `delta zip is not flat (contains pocketshell/ entries): ` +
      `${nested.slice(0, 5).join(', ')}${nested.length > 5 ? ', ...' : ''}`,
  );
}

console.log(`zip-ok: ${names.length} entries`);
