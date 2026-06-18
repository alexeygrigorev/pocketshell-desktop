/**
 * Orchestrator for the extension-delta updater.
 *
 * Combines manifest parsing, comparison, downloading, verification, and
 * installation into two entry points: {@link checkForUpdate} (read-only,
 * fail-safe) and {@link applyUpdate} (mutates the extension directory).
 *
 * Pure backend logic: no `vscode` import. The canonical copy lives in
 * `src/updates/` (unit-tested); the byte-identical mirror in
 * `extensions/pocketshell/src/backend/updates/` runs inside the extension host.
 *
 * See issue #96.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { downloadToFile, FetchImpl } from './downloader';
import { installExtensionUpdate, InstallResult } from './installer';
import { compareUpdate, parseManifest, UpdateManifest, VersionCompareResult } from './manifest';
import { safeStrEqual } from './verifier';

export type { UpdateManifest, VersionCompareResult } from './manifest';
export type { InstallResult } from './installer';
export type { FetchImpl } from './downloader';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of {@link checkForUpdate}; carries the manifest when one applies. */
export interface UpdateCheckResult {
  status: VersionCompareResult['kind'];
  manifest?: UpdateManifest;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/**
 * Fetch and evaluate the update manifest, never throwing.
 *
 * On a network or parse error, returns `{ status: 'check-failed' }` so the
 * caller can decide whether to surface a message. The running app is never
 * disrupted by an update check.
 */
export async function checkForUpdate(
  manifestUrl: string,
  opts: { currentVersion: string; currentBaseVersion: string },
  fetchImpl: FetchImpl = fetch,
): Promise<UpdateCheckResult> {
  let response: Response;
  try {
    response = await fetchImpl(manifestUrl);
  } catch {
    return { status: 'check-failed' };
  }

  if (!response.ok) {
    return { status: 'check-failed' };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { status: 'check-failed' };
  }

  const manifest = parseManifest(json);
  if (!manifest) {
    return { status: 'check-failed' };
  }

  const result = compareUpdate(manifest, opts);
  if (result.kind === 'available') {
    return { status: 'available', manifest };
  }
  // For non-available outcomes (up-to-date, base-mismatch, below-min-app) we
  // still surface the manifest so the caller can report specifics if desired.
  return { status: result.kind, manifest };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Download, verify, and install a delta described by `manifest`.
 *
 * 1. Download `manifest.downloadUrl` to a temp file in the OS tempdir,
 *    capturing the sha256 of the downloaded bytes.
 * 2. Compare it to `manifest.sha256` with a constant-time compare; throw on
 *    mismatch (the temp file is cleaned up).
 * 3. Install via {@link installExtensionUpdate} (atomic swap + rollback).
 * 4. Clean up the temp zip regardless of outcome.
 *
 * @throws {Error} if the downloaded sha256 does not match the manifest.
 * @throws {UpdatePermissionError} if the target directory is not writable.
 */
export async function applyUpdate(
  manifest: UpdateManifest,
  targetDir: string,
  opts?: { fetchImpl?: FetchImpl },
): Promise<InstallResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const tmpPath = path.join(
    os.tmpdir(),
    `pocketshell-delta-${manifest.version}-${Date.now()}.zip`,
  );

  try {
    const downloadedSha = await downloadToFile(
      manifest.downloadUrl,
      tmpPath,
      fetchImpl,
    );

    if (!safeStrEqual(downloadedSha, manifest.sha256)) {
      throw new Error(
        `Update verification failed: sha256 mismatch (expected ${manifest.sha256}, got ${downloadedSha})`,
      );
    }

    return await installExtensionUpdate(tmpPath, targetDir);
  } finally {
    try {
      const fs = await import('node:fs');
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort temp cleanup.
    }
  }
}
