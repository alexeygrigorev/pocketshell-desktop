// Portable, Node-only packager for the extension-delta zip.
//
// Produces a FLAT deflate zip of a directory's contents — semantically the
// same as `( cd <srcDir> && zip -r -X <outZip> . )`, but with NO dependency on
// a system `zip` binary. `zip` is NOT available on the windows-2022 GitHub
// runner (the actions/runner-images Windows2022-Readme lists only `7zip`, not
// `zip`; MSYS2/Git-Bash require `pacman -S zip`), so the previous
// `( cd "$EXT_DIR" && zip -r -X ... )` step in .github/workflows/release.yml
// FAILED on the win32-x64 matrix job and broke every Windows release.
//
// We build the zip with `yazl` — yauzl's companion library, the one npm itself
// uses to CREATE zips. It is pure JavaScript (no native binding, no system
// tool), so it runs identically on linux/win32/darwin runners.
//
// Why the resolution dance below (createRequire + fallback): the release
// `build` job does NOT run a root `npm install`, so `$GITHUB_WORKSPACE/
// node_modules/yazl` is absent in CI. It DOES run `cd vendor/vscode && npm
// install` (in prepare-base, then cached), and `yazl` is a declared VS Code
// dependency — so `vendor/vscode/node_modules/yazl` is reliably present on all
// three matrix runners. Locally (where root devDeps ARE installed) the first
// `require('yazl')` succeeds. We try both so the SAME script works in dev and
// CI without a conditional.
//
// Layout contract: entries are stored at the EXTENSION ROOT (e.g.
// `out/extension.js`, `package.json`, `node_modules/ssh2/...`), with NO
// `pocketshell/` wrapper. The runtime extractor
// (extensions/pocketshell/src/backend/updates/installer.ts, mirrored at
// src/updates/installer.ts) writes entries with no parent-dir stripping, so a
// nested wrapper would break installation. scripts/check-delta-zip.mjs asserts
// this layout and is run immediately after this packager in the workflow.
//
// Usage: node scripts/package-extension-delta.mjs <srcDir> <outZip>
//   Exits 0 + "wrote <outZip> (<N> entries, <bytes>)" on success,
//   non-zero with a clear message on failure.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

// ---------------------------------------------------------------------------
// yazl resolution (see header comment for the why)
// ---------------------------------------------------------------------------

/**
 * Resolve the `yazl` module from wherever it is actually installed.
 *
 * Order:
 *   1. `require('yazl')` — works wherever yazl is in the Node resolution path
 *      (locally, root devDeps are installed; in any context that bundles it).
 *   2. Explicit absolute path under the vendored VS Code tree:
 *      `$GITHUB_WORKSPACE/vendor/vscode/node_modules/yazl` (falling back to
 *      `process.cwd()` when GITHUB_WORKSPACE is unset). This path is reliably
 *      present in CI because prepare-base runs `npm install` in vendor/vscode
 *      (yazl is a VS Code dep) and caches vendor/vscode across the build job.
 *
 * @returns {typeof import('yazl')}
 */
function resolveYazl() {
  const requireFromHere = createRequire(import.meta.url);

  // 1. Plain resolution.
  try {
    return requireFromHere('yazl');
  } catch {
    // fall through to explicit path
  }

  // 2. Explicit vendored path (the CI-reliable location).
  const workspaceOrCwd = process.env.GITHUB_WORKSPACE || process.cwd();
  const vendoredEntry = path.join(
    workspaceOrCwd,
    'vendor',
    'vscode',
    'node_modules',
    'yazl',
  );
  try {
    return requireFromHere(vendoredEntry);
  } catch {
    // fall through to error
  }

  throw new Error(
    'Could not resolve the "yazl" module. It is a declared VS Code ' +
      'dependency and is expected at vendor/vscode/node_modules/yazl in CI ' +
      '(after the prepare-base job runs `npm install` there). Locally, add ' +
      'yazl to the repo-root devDependencies and run `npm install`. Tried: ' +
      `require('yazl') and explicit path "${vendoredEntry}".`,
  );
}

// ---------------------------------------------------------------------------
// Recursive directory walk
// ---------------------------------------------------------------------------

/**
 * Walk `dir` depth-first and yield `{ abs, rel }` for every filesystem entry,
 * where `rel` is the POSIX-separated path relative to `dir`.
 *
 * Directories are yielded with `rel` ending in `/` so callers can decide
 * whether to emit them as directory entries. Symlinks are NOT followed
 * (matches `zip`'s default; avoids cycles and duplicates via symlinks).
 *
 * @returns {Generator<{ abs: string; rel: string; isDir: boolean }>}
 */
function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`could not read directory "${dir}": ${err.message}`);
  }

  // Sort for deterministic ordering (zip -r is filesystem-order, but a stable
  // order here is strictly nicer for diffs and does not affect correctness —
  // the manifest sha is computed from the actual bytes after packaging).
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    const rel = ent.name;

    // Treat symlinks as regular files: do not traverse. (zip's default is to
    // store the link target's name and not follow; we instead store whatever
    // the entry is by reading it as a stream. The extension dir contains no
    // symlinks that matter for packaging.)
    if (ent.isDirectory() && !ent.isSymbolicLink()) {
      yield { abs, rel: rel + '/', isDir: true };
      yield* walkInner(abs, rel);
    } else {
      yield { abs, rel, isDir: false };
    }
  }
}

function* walkInner(dir, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`could not read directory "${dir}": ${err.message}`);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    const rel = `${prefix}/${ent.name}`;
    if (ent.isDirectory() && !ent.isSymbolicLink()) {
      yield { abs, rel: rel + '/', isDir: true };
      yield* walkInner(abs, rel);
    } else {
      yield { abs, rel, isDir: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Core packager (testable)
// ---------------------------------------------------------------------------

/**
 * Package the contents of `srcDir` into a FLAT deflate zip at `outZip`.
 *
 * Every regular file under `srcDir` (including node_modules/**, out/**, native
 * *.node binaries, package.json, base-version.json) is added at a path RELATIVE
 * to `srcDir` with POSIX separators — so `srcDir/out/extension.js` becomes the
 * zip entry `out/extension.js`, with no `pocketshell/` prefix. Empty
 * directories are preserved via yazl's `addEmptyDirectory`. Compression is
 * deflate (yazl's default); STORE is not forced.
 *
 * Resolves once the output stream has fully drained to disk.
 *
 * @param {string} srcDir  Directory whose contents are zipped (its OWN name is
 *   not part of any entry path).
 * @param {string} outZip  Absolute (or cwd-relative) path of the zip to write.
 * @returns {Promise<{ entryCount: number; bytes: number }>}
 */
export async function packageExtensionDelta(srcDir, outZip) {
  // Validate inputs up front so callers get clear errors before any I/O.
  if (typeof srcDir !== 'string' || srcDir.length === 0) {
    throw new Error('srcDir must be a non-empty string');
  }
  if (typeof outZip !== 'string' || outZip.length === 0) {
    throw new Error('outZip must be a non-empty string');
  }
  let srcStats;
  try {
    srcStats = fs.statSync(srcDir);
  } catch (err) {
    throw new Error(`srcDir does not exist: "${srcDir}": ${err.message}`);
  }
  if (!srcStats.isDirectory()) {
    throw new Error(`srcDir is not a directory: "${srcDir}"`);
  }

  const yazl = resolveYazl();
  const zipfile = new yazl.ZipFile();

  // Normalize outZip to an absolute path so the "skip the output zip itself"
  // comparison is reliable regardless of how the caller passed it.
  const absOutZip = path.resolve(outZip);

  // Ensure the destination directory exists (zip -r does not, but the workflow
  // writes into $GITHUB_WORKSPACE which always exists; doing it here makes the
  // tool robust when invoked directly with a nested out path).
  const outDir = path.dirname(absOutZip);
  fs.mkdirSync(outDir, { recursive: true });

  // Forward yazl errors to a single rejection point. We attach this BEFORE
  // adding entries so an error during pumping rejects the promise rather than
  // crashing the process.
  /** @type {Promise<never>} */
  const yazlError = new Promise((_, reject) => {
    zipfile.on('error', (err) => reject(err));
  });
  // Suppress the unhandled-rejection warning for the LATE-FIRE case: if yazl
  // emits an error AFTER pipeline() already resolved (success path),
  // `yazlError` still rejects with no .then/.catch attached to *this* view of
  // it. Promise.race gets its OWN view and still observes the rejection on the
  // error path, so this .catch only affects the post-success late fire and
  // does NOT mask a real failure.
  yazlError.catch(() => {});

  let entryCount = 0;
  for (const ent of walk(srcDir)) {
    // Defensive: never include the output zip itself (if it happens to live
    // inside srcDir we'd otherwise read our own output as we write it).
    if (path.resolve(ent.abs) === absOutZip) continue;

    if (ent.isDir) {
      // Preserve empty directories. (Non-empty dirs are implicitly recreated
      // by the extractor when it writes their children, but adding them is
      // harmless and matches `zip -r` more closely. The validator only looks
      // at file entries, so directory entries never trip the flat-layout
      // check.)
      zipfile.addEmptyDirectory(ent.rel, { mode: 0o755 });
      entryCount++;
      continue;
    }

    // addFile over addReadStream: yazl opens/reads the file ITSELF and handles
    // read errors internally (it attaches its own readStream.on('error') that
    // emits on the zipfile, then pumps). The previous manual
    // `fs.createReadStream` + `stream.on('error', () => zipfile.emit('error'))`
    // wiring could lose an error if the stream errored before yazl began
    // pumping it. `addFile` exists with the same signature
    // `(realPath, metadataPath, options)` in BOTH yazl 2.4.3 (vendored) and
    // 2.5.1 (root devDep), confirmed identical at the source level. Compress:
    // true is yazl's default (deflate, method 8) — do not force STORE.
    zipfile.addFile(ent.abs, ent.rel, { compress: true });
    entryCount++;
  }

  // Signal yazl that all entries have been added. The outputStream is a
  // PassThrough that begins emitting bytes as soon as entries are pumped; we
  // only pipe it now so all header bytes land in order.
  zipfile.end();

  const writeStream = fs.createWriteStream(absOutZip);
  // Route write-stream errors onto the zipfile so the yazlError race observes
  // them too (defense-in-depth alongside pipeline()'s own rejection).
  writeStream.on('error', (err) => zipfile.emit('error', err));

  // Race the pipeline against a yazl error so either failure mode rejects.
  // pipeline() resolves on the write stream's 'finish' (after all bytes are
  // flushed), which is the semantic we want. The race is REQUIRED: a yazl error
  // that fires on the ZipFile but does NOT propagate to outputStream would
  // otherwise leave pipeline() awaiting a 'finish' that never comes (an
  // infinite hang) — the race is what breaks that hang.
  try {
    await Promise.race([
      pipeline(zipfile.outputStream, writeStream),
      yazlError,
    ]);
  } catch (err) {
    // Clean teardown on the error path: destroy the write stream (it may still
    // be open) and remove the truncated/partial outZip so callers don't see a
    // half-written file. Best-effort unlink: a missing file (e.g. writeStream
    // errored before open) must NOT mask the original error.
    writeStream.destroy();
    try {
      fs.unlinkSync(absOutZip);
    } catch {
      // ignore — file may not exist or may already be gone
    }
    throw err;
  }

  const bytes = fs.statSync(absOutZip).size;
  return { entryCount, bytes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * CLI entry. Validates argv, calls {@link packageExtensionDelta}, prints a
 * short success line, and exits non-zero on any error.
 *
 * @param {string[]} argv  Typically process.argv.slice(2).
 * @returns {Promise<number>}  Process exit code (0 on success).
 */
export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    console.error(
      'usage: node scripts/package-extension-delta.mjs <srcDir> <outZip>',
    );
    console.error(
      `  expected exactly 2 arguments, got ${argv.length}` +
        (argv.length ? `: ${argv.join(' ')}` : ''),
    );
    return 1;
  }

  const [srcDir, outZip] = argv;

  try {
    const { entryCount, bytes } = await packageExtensionDelta(srcDir, outZip);
    console.log(
      `wrote ${outZip} (${entryCount} entries, ${bytes} bytes)`,
    );
    return 0;
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Run only when executed directly (not when imported by tests).
//
// OS-AGNOSTIC GUARD: compare the canonicalized OS-native path of argv[1]
// against the canonicalized path of this module. `fileURLToPath(import.meta.url)`
// normalizes to the platform-native form on linux/win32/darwin
// (e.g. on Windows it yields `D:\a\...\package-extension-delta.mjs`), which is
// exactly what `process.argv[1]` is. The old `import.meta.url ===
// \`file://${process.argv[1]}\` template comparison NEVER matched on Windows
// (import.meta.url is `file:///D:/a/.../script.mjs`, triple-slash + forward
// slashes; argv[1] is `D:\a\...\script.mjs`, backslashes) → main() never ran
// → the win32-x64 release job produced NO zip and check-delta-zip failed.
// See https://nodejs.org/api/esm.html#importmetaurl-invocation-type-detection.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
