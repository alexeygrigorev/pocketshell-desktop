/**
 * Pure version-comparison utilities for pocketshell.
 *
 * All functions are side-effect free and operate on semver-style strings
 * (e.g. "1.2.3", "0.0.0").
 */

/**
 * The MINIMUM PocketShell CLI version the desktop requires on a remote host.
 *
 * This is the declared floor: when the installed remote CLI is strictly older
 * than this version, the desktop surfaces a warning and offers the existing
 * "Upgrade CLI" action (`pocketshell.bootstrap.upgrade`). The PocketShell CLI
 * is versioned independently of the desktop (its releases live at
 * github.com/alexeygrigorev/pocketshell; the desktop reads the live "latest"
 * separately via BootstrapManager.fetchLatestVersion).
 *
 * Pinned to the current CLI release, 0.4.7 (published 2026-06-17). Bump this
 * when the desktop is validated against a newer CLI release, or when a desktop
 * feature starts depending on CLI behaviour that did not exist below a given
 * release.
 */
export const MIN_POCKETSHELL_CLI_VERSION = '0.4.7';

/**
 * Compare two semver-style version strings.
 *
 * @returns -1 if `a` < `b`, 0 if equal, 1 if `a` > `b`.
 *
 * @example
 *   compareVersions('1.0.0', '1.1.0')  // -1
 *   compareVersions('2.0.0', '1.9.9')  //  1
 *   compareVersions('1.0.0', '1.0.0')  //  0
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseParts(a);
  const pb = parseParts(b);

  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/**
 * Return `true` when `latest` is strictly newer than `current`.
 */
export function isUpdateAvailable(current: string, latest: string): boolean {
  return compareVersions(current, latest) < 0;
}

/**
 * Return `true` when `installed` meets or exceeds the `minimum` version.
 *
 * Equal versions are considered compatible. An `installed` value of
 * `'0.0.0'` (the sentinel returned when the version cannot be detected) is
 * treated as NOT compatible, since we cannot verify it meets the floor.
 *
 * @example
 *   isVersionCompatible('1.2.3', '1.0.0')  // true
 *   isVersionCompatible('1.0.0', '1.0.0')  // true  (equal is OK)
 *   isVersionCompatible('0.9.9', '1.0.0')  // false
 *   isVersionCompatible('0.0.0', '1.0.0')  // false (unknown sentinel)
 */
export function isVersionCompatible(installed: string, minimum: string): boolean {
  if (installed === '0.0.0') {
    return false;
  }
  return compareVersions(installed, minimum) >= 0;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a version string like "1.2.3" into an array of non-negative integers.
 * Trailing non-numeric segments are silently ignored.
 */
function parseParts(v: string): number[] {
  return v
    .split('.')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
}
