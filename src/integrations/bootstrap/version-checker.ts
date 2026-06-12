/**
 * Pure version-comparison utilities for pocketshell.
 *
 * All functions are side-effect free and operate on semver-style strings
 * (e.g. "1.2.3", "0.0.0").
 */

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
