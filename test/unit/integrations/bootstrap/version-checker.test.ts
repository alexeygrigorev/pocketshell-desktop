/**
 * Unit tests for version-checker pure functions.
 */

import { describe, it, expect } from 'vitest';
import { compareVersions, isUpdateAvailable } from '../../../../src/integrations/bootstrap/version-checker';

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
