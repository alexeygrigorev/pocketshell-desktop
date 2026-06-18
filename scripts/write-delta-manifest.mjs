// Portable, dependency-free writer + self-validator for the extension-delta
// update manifest (`latest-<platform>.json`).
//
// Closes the v0.1.4 release blocker (#96): the SHIPPED win32-x64 manifest was
// invalid JSON — its `sha256` field had a stray leading backslash
// (`"sha256": "\db4444a9..."`), so `JSON.parse` threw "Bad escaped character"
// and the in-app updater could not parse it, breaking every Windows in-app
// update.
//
// Root cause (confirmed from the job log): the release workflow computed the
// hash with shell tools —
//     SHA="$(sha256sum "$ZIP_PATH" | awk '{print $1}')"
// — and on the windows-2022 Git-Bash runner this produced `\db4444...` (a
// leading backslash before the hash). The corruption was VALUE-TRIGGERED: the
// win32 zip's sha began with `db`, and the bash capture mangled it, while the
// linux/darwin hashes (different leading bytes) came through clean. The shell
// `sha256sum | awk` capture is the culprit; do not try to "fix" it in bash.
//
// The fix is to remove the shell-hash dependency ENTIRELY. This script hashes
// the zip in-process with `node:crypto` — byte-exact and identical on every
// platform — and writes the manifest itself. As a safety net it then
// RE-READS, `JSON.parse`s, and asserts the output (all four fields non-empty
// strings; sha matches the freshly-computed hash AND `/^[0-9a-f]{64}$/`), so a
// corrupt manifest can never be uploaded again: any mismatch exits non-zero
// and the release job fails.
//
// Output is byte-compatible in SHAPE with the (working) linux/darwin manifests:
// pretty JSON, 2-space indent, exactly these four fields in this order, with a
// trailing newline. (`JSON.stringify` with a 2-space indent + a trailing `\n`
// reproduces the layout the previous `printf` emitted.)
//
// Usage:
//   node scripts/write-delta-manifest.mjs \
//     <version> <repo> <tag> <zipName> <zipPath> <baseVersion> <outPath>
// Exits 0 + "wrote <outPath> (...)" on success, non-zero with a clear message
// on failure. Only `node:` builtins are used — NO external deps — so this runs
// identically on the linux/win32/darwin GitHub runners without an install step.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Core writer (testable)
// ---------------------------------------------------------------------------

/**
 * Compute the lowercase-hex sha256 of the file at `zipPath` via `node:crypto`.
 *
 * This is the root-cause fix: hashing in Node is byte-exact on all platforms
 * and never produces the stray-leading-backslash corruption that the windows
 * Git-Bash `sha256sum | awk` capture did.
 *
 * @param {string} zipPath  Path to the file to hash (the delta zip).
 * @returns {string} 64-char lowercase-hex sha256.
 */
function sha256OfFile(zipPath) {
  const buf = fs.readFileSync(zipPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Write the extension-delta manifest at `outPath` and self-validate it.
 *
 * The manifest is deterministic pretty JSON (2-space indent, trailing newline)
 * with exactly these four fields in this order:
 *
 *   version      — the bare version, e.g. "0.1.4" (NO leading "v")
 *   downloadUrl  — `https://github.com/<repo>/releases/download/<tag>/<zipName>`,
 *                  matching the uploaded asset filename exactly
 *   sha256       — lowercase-hex sha256 of the bytes at `zipPath`
 *   baseVersion  — the vendored VS Code git sha this delta is built against
 *
 * Before returning, the written file is re-read, `JSON.parse`d, and asserted:
 *   - all four fields are non-empty strings
 *   - `sha256` matches `/^[0-9a-f]{64}$/` (the regression — clean hex, no
 *     backslash/whitespace)
 *   - `sha256` equals the hash freshly computed from `zipPath`
 *   - `version`/`downloadUrl`/`baseVersion` equal the inputs
 * Any mismatch throws, so a corrupt manifest can never be uploaded — the
 * release job fails instead.
 *
 * @param {string} version      Bare version (e.g. "0.1.4").
 * @param {string} repo         GitHub `<owner>/<name>` for the download URL.
 * @param {string} tag          Git tag (e.g. "v0.1.4") for the download URL.
 * @param {string} zipName      Asset filename (e.g. "pocketshell-extension-0.1.4-win32-x64.zip").
 * @param {string} zipPath      Path to the zip file to hash.
 * @param {string} baseVersion  Vendored VS Code sha the delta is built against.
 * @param {string} outPath      Where to write the manifest JSON.
 * @returns {{ sha: string }}  The computed sha (for logging).
 */
export function writeDeltaManifest(
  version,
  repo,
  tag,
  zipName,
  zipPath,
  baseVersion,
  outPath,
) {
  // Validate argv up front so callers get clear errors before any I/O.
  const fields = { version, repo, tag, zipName, zipPath, baseVersion, outPath };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`${k} must be a non-empty string`);
    }
  }

  // zipPath must exist and be readable — fail loud with a clear message rather
  // than letting readFileSync throw an opaque ENOENT deep in the hash step.
  try {
    fs.accessSync(zipPath, fs.constants.R_OK);
  } catch (err) {
    throw new Error(
      `zipPath is not readable: "${zipPath}": ${err.message}`,
    );
  }

  // Compute sha in-process (node:crypto). No shell, no awk, no platform drift.
  const sha = sha256OfFile(zipPath);

  // Build the manifest. Field set + order MUST match the published
  // linux/darwin manifests so the runtime parser and any external tooling see
  // the same shape. 2-space indent + trailing newline reproduces what the old
  // printf block emitted.
  const downloadUrl = `https://github.com/${repo}/releases/download/${tag}/${zipName}`;
  const manifest = {
    version,
    downloadUrl,
    sha256: sha,
    baseVersion,
  };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;

  // Ensure the destination directory exists (printf wrote into
  // $GITHUB_WORKSPACE which always exists; doing it here makes the tool robust
  // when invoked directly with a nested out path).
  const outDir = path.dirname(path.resolve(outPath));
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(outPath, json, 'utf8');

  // SELF-VALIDATE: re-read + parse + assert. This is the safety net that
  // guarantees a corrupt manifest can never ship. If the written bytes don't
  // parse — or any field is empty / the sha is malformed / the sha doesn't
  // match what we just computed — throw. The release job exits non-zero on a
  // thrown error, which is exactly what we want.
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `self-validation failed: written manifest is not valid JSON: ${err.message}`,
    );
  }

  const REQUIRED = ['version', 'downloadUrl', 'sha256', 'baseVersion'];
  for (const key of REQUIRED) {
    if (typeof parsed[key] !== 'string' || parsed[key].length === 0) {
      throw new Error(
        `self-validation failed: field "${key}" is missing or empty`,
      );
    }
  }

  // The regression: sha must be 64 lowercase hex chars with NO stray leading
  // backslash (the v0.1.4 win32 manifest had `\db4444...`).
  if (!/^[0-9a-f]{64}$/.test(parsed.sha256)) {
    throw new Error(
      `self-validation failed: sha256 is not 64-char lowercase hex: ` +
        `"${parsed.sha256}"`,
    );
  }

  // Belt-and-suspenders: the sha in the file must equal the hash we just
  // computed from the source bytes. (Catches a hypothetical future bug where
  // the written sha drifts from the computed one.)
  if (parsed.sha256 !== sha) {
    throw new Error(
      `self-validation failed: sha256 in file ("${parsed.sha256}") does not ` +
        `match computed sha ("${sha}")`,
    );
  }

  // Round-trip the user-facing fields too.
  if (parsed.version !== version) {
    throw new Error(
      `self-validation failed: version "${parsed.version}" != "${version}"`,
    );
  }
  if (parsed.downloadUrl !== downloadUrl) {
    throw new Error(
      `self-validation failed: downloadUrl "${parsed.downloadUrl}" != ` +
        `"${downloadUrl}"`,
    );
  }
  if (parsed.baseVersion !== baseVersion) {
    throw new Error(
      `self-validation failed: baseVersion "${parsed.baseVersion}" != ` +
        `"${baseVersion}"`,
    );
  }

  return { sha };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * CLI entry. Validates argv count, calls {@link writeDeltaManifest}, prints a
 * short success line, and exits non-zero on any error.
 *
 * @param {string[]} argv  Typically process.argv.slice(2).
 * @returns {number}  Process exit code (0 on success).
 */
export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 7) {
    console.error(
      'usage: node scripts/write-delta-manifest.mjs ' +
        '<version> <repo> <tag> <zipName> <zipPath> <baseVersion> <outPath>',
    );
    console.error(
      `  expected exactly 7 arguments, got ${argv.length}` +
        (argv.length ? `: ${argv.join(' ')}` : ''),
    );
    return 1;
  }

  const [version, repo, tag, zipName, zipPath, baseVersion, outPath] = argv;

  try {
    const { sha } = writeDeltaManifest(
      version,
      repo,
      tag,
      zipName,
      zipPath,
      baseVersion,
      outPath,
    );
    console.log(
      `wrote ${outPath} (version ${version}, sha ${sha.slice(0, 8)}…)`,
    );
    return 0;
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Run only when executed directly (not when imported by tests).
//
// OS-AGNOSTIC GUARD: compare argv[1] against the canonicalized OS-native path
// of this module. `fileURLToPath(import.meta.url)` normalizes to the
// platform-native form on linux/win32/darwin (on Windows it yields
// `D:\a\...\write-delta-manifest.mjs`), which is exactly what `process.argv[1]`
// is. The old `import.meta.url === \`file://${process.argv[1]}\` template
// comparison NEVER matched on Windows (triple-slash + forward slashes vs
// backslashes) → main() never ran. Copied verbatim from
// package-extension-delta.mjs. See
// https://nodejs.org/api/esm.html#importmetaurl-invocation-type-detection.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
