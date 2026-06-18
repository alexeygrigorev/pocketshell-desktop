/**
 * Update manifest parsing and version comparison for the PocketShell
 * extension-delta updater.
 *
 * Pure backend logic: no `vscode` import, no I/O. All functions here are
 * independently unit-testable. The manifest is a small JSON document fetched
 * from a release channel URL describing the latest extension-only delta.
 *
 * See issue #96: PocketShell Desktop ships ~300MB archives, but ~290MB
 * (VS Code core + Electron at pinned VSCODE_REF) is identical across releases
 * — only the extension layer changes. This module validates the manifest that
 * describes such a delta.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Describes an available extension-delta update.
 *
 * `baseVersion` is the VS Code / Electron base the delta was built against; it
 * must match the running app's base or the delta cannot be applied.
 */
export interface UpdateManifest {
  /** Extension version offered by this delta (semver-ish, e.g. "0.1.4"). */
  version: string;
  /** HTTPS URL to the delta zip (a zip of `extensions/pocketshell/`). */
  downloadUrl: string;
  /** Lowercase hex sha256 of the zip bytes, for download verification. */
  sha256: string;
  /** VS Code base version this delta is compatible with. */
  baseVersion: string;
  /** If set, the running app version must be >= this or the delta is rejected. */
  minAppVersion?: string;
  /** Optional human-readable release notes. */
  releaseNotes?: string;
}

/**
 * Outcome of comparing a manifest against the running app's versions.
 *
 * - `up-to-date`     — manifest version is not newer than current.
 * - `available`      — a newer, compatible delta is available.
 * - `base-mismatch`  — delta's baseVersion differs from the running base.
 * - `below-min-app`  — running app is older than the delta's minAppVersion.
 * - `check-failed`   — the update check itself failed (network/parse error).
 */
export interface VersionCompareResult {
  kind:
    | 'up-to-date'
    | 'available'
    | 'base-mismatch'
    | 'below-min-app'
    | 'check-failed';
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Split a version string into a numeric tuple, ignoring pre-release suffixes.
 *
 * Missing segments are treated as 0, so "1.2" compares equal to "1.2.0".
 * Non-numeric segments are treated as 0 so malformed input degrades safely
 * rather than throwing.
 *
 * NOTE: pre-release/build metadata is intentionally ignored for simplicity
 * (e.g. "1.0.0-rc1" is treated as "1.0.0"). This is sufficient for the
 * extension-delta updater, which only compares released extension versions.
 */
function toNumericTuple(version: string): [number, number, number] {
  const core = version.split(/[+-]/)[0]; // strip pre-release / build
  const parts = core.split('.');
  const seg = (i: number): number => {
    const n = Number(parts[i]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  return [seg(0), seg(1), seg(2)];
}

/**
 * Return true if `candidate` is strictly newer than `current`.
 *
 * Uses a minimal numeric tuple compare (major.minor.patch). Pre-release
 * suffixes are ignored. Malformed versions compare as 0.0.0.
 */
export function isNewer(candidate: string, current: string): boolean {
  const [a0, a1, a2] = toNumericTuple(candidate);
  const [b0, b1, b2] = toNumericTuple(current);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate and parse a raw (already JSON-decoded) value into an
 * {@link UpdateManifest}.
 *
 * Returns `null` if the shape is invalid or any required field
 * (`version`, `downloadUrl`, `sha256`, `baseVersion`) is missing/blank.
 * `sha256` must be a 64-character hex string.
 */
export function parseManifest(raw: unknown): UpdateManifest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const version = obj['version'];
  const downloadUrl = obj['downloadUrl'];
  const sha256 = obj['sha256'];
  const baseVersion = obj['baseVersion'];

  if (
    !isNonEmptyString(version) ||
    !isNonEmptyString(downloadUrl) ||
    !isNonEmptyString(baseVersion)
  ) {
    return null;
  }

  if (!isNonEmptyString(sha256)) return null;
  // sha256 must be 64 hex chars (case-insensitive).
  if (!/^[0-9a-fA-F]{64}$/.test(sha256)) return null;

  const manifest: UpdateManifest = {
    version,
    downloadUrl,
    sha256: sha256.toLowerCase(),
    baseVersion,
  };

  if (isNonEmptyString(obj['minAppVersion'] as unknown)) {
    manifest.minAppVersion = obj['minAppVersion'] as string;
  }
  if (typeof obj['releaseNotes'] === 'string') {
    manifest.releaseNotes = obj['releaseNotes'];
  }

  return manifest;
}

/**
 * Compare a manifest against the running app's versions.
 *
 * Order of checks: base-mismatch → below-min-app → up-to-date/available.
 * The result kind is deterministic and caller-actionable.
 */
export function compareUpdate(
  manifest: UpdateManifest,
  opts: { currentVersion: string; currentBaseVersion: string },
): VersionCompareResult {
  if (manifest.baseVersion !== opts.currentBaseVersion) {
    return { kind: 'base-mismatch' };
  }
  if (
    manifest.minAppVersion &&
    isNewer(manifest.minAppVersion, opts.currentVersion)
  ) {
    return { kind: 'below-min-app' };
  }
  if (isNewer(manifest.version, opts.currentVersion)) {
    return { kind: 'available' };
  }
  return { kind: 'up-to-date' };
}
