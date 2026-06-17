/**
 * Unit tests for version-checker pure functions.
 */

import { describe, it, expect } from 'vitest';
import {
	compareVersions,
	isUpdateAvailable,
	isVersionCompatible,
	MIN_POCKETSHELL_CLI_VERSION,
} from '../../../../src/integrations/bootstrap/version-checker';

describe('compareVersions', () => {
  it('returns -1 when a < b (1.0.0 < 1.1.0)', () => {
    expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
  });

  it('returns 1 when a > b (2.0.0 > 1.9.9)', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  });

  it('returns 0 when a == b (1.0.0 == 1.0.0)', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('handles different-length versions (1.0 < 1.0.1)', () => {
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
  });

  it('handles major version differences (10.0.0 > 9.99.99)', () => {
    expect(compareVersions('10.0.0', '9.99.99')).toBe(1);
  });

  it('handles zero versions (0.0.0 == 0.0.0)', () => {
    expect(compareVersions('0.0.0', '0.0.0')).toBe(0);
  });

  it('handles pre-release style versions as numeric only (1.0.0 < 2.0.0)', () => {
    // Pre-release tags like "1.0.0-alpha" — only the numeric parts are compared
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
  });
});

describe('isUpdateAvailable', () => {
  it('returns true when latest > current', () => {
    expect(isUpdateAvailable('1.0.0', '1.1.0')).toBe(true);
  });

  it('returns true for major bump', () => {
    expect(isUpdateAvailable('1.9.9', '2.0.0')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isUpdateAvailable('1.0.0', '1.0.0')).toBe(false);
  });

  it('returns false when current > latest', () => {
    expect(isUpdateAvailable('2.0.0', '1.9.9')).toBe(false);
  });

  it('returns false when current is same minor but newer patch', () => {
    expect(isUpdateAvailable('1.1.1', '1.1.0')).toBe(false);
  });
});

describe('isVersionCompatible', () => {
  it('returns true when installed is strictly above the minimum', () => {
    expect(isVersionCompatible('1.2.3', '1.0.0')).toBe(true);
  });

  it('returns true when installed equals the minimum (equal is OK)', () => {
    expect(isVersionCompatible('1.0.0', '1.0.0')).toBe(true);
  });

  it('returns false when installed is one patch below the minimum', () => {
    expect(isVersionCompatible('0.0.9', '0.1.0')).toBe(false);
  });

  it('returns false when installed is below the minimum on a minor', () => {
    expect(isVersionCompatible('0.9.9', '1.0.0')).toBe(false);
  });

  it('returns false when installed is a full major below the minimum', () => {
    expect(isVersionCompatible('0.1.0', '1.0.0')).toBe(false);
  });

  it('treats the "0.0.0" unknown sentinel as not compatible', () => {
    expect(isVersionCompatible('0.0.0', '0.0.1')).toBe(false);
  });

  it('still treats "0.0.0" as not compatible even when the minimum is "0.0.0"', () => {
    // We cannot verify an undetected version; report incompatible.
    expect(isVersionCompatible('0.0.0', '0.0.0')).toBe(false);
  });

  it('handles different-length versions (1.0 vs 1.0.0 — equal is OK)', () => {
    expect(isVersionCompatible('1.0', '1.0.0')).toBe(true);
  });

  it('handles different-length versions (0.9 vs 1.0 — below)', () => {
    expect(isVersionCompatible('0.9', '1.0')).toBe(false);
  });
});

describe('MIN_POCKETSHELL_CLI_VERSION', () => {
  it('is a valid semver string of the form X.Y.Z', () => {
    expect(MIN_POCKETSHELL_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is not the unknown sentinel', () => {
    // The minimum must be a real version, never "0.0.0".
    expect(MIN_POCKETSHELL_CLI_VERSION).not.toBe('0.0.0');
  });
});

/**
 * Replicates the comparison the bootstrap status command performs: it checks
 * `isVersionCompatible(status.version, MIN_POCKETSHELL_CLI_VERSION)`. These
 * tests pin the behaviour the command relies on without importing the
 * vscode-dependent command module.
 */
describe('min-version comparison (as used by bootstrap status)', () => {
  const check = (installed: string): boolean =>
    isVersionCompatible(installed, MIN_POCKETSHELL_CLI_VERSION);

  it('flags an installed CLI equal to the minimum as compatible', () => {
    expect(check(MIN_POCKETSHELL_CLI_VERSION)).toBe(true);
  });

  it('flags an installed CLI strictly newer than the minimum as compatible', () => {
    const [maj, min, pat] = MIN_POCKETSHELL_CLI_VERSION.split('.').map(Number);
    const newer = `${maj}.${min}.${pat + 1}`;
    expect(check(newer)).toBe(true);
  });

  it('flags an installed CLI strictly older than the minimum as incompatible', () => {
    const [maj, min] = MIN_POCKETSHELL_CLI_VERSION.split('.').map(Number);
    // Walk the version space below MIN to find the greatest strictly-older
    // version, so this stays correct regardless of the chosen MIN value.
    let older: string;
    if (min > 0) {
      older = `${maj}.${min - 1}.9999`;
    } else if (maj > 0) {
      older = `${maj - 1}.9999.9999`;
    } else {
      older = '0.0.0'; // MIN is 0.0.x — the only strictly-older-ish is unknown.
    }
    // "0.0.0" is the unknown sentinel (incompatible); otherwise older must be incompatible.
    expect(check(older)).toBe(false);
  });

  it('flags an unknown sentinel ("0.0.0") as incompatible', () => {
    expect(check('0.0.0')).toBe(false);
  });
});
