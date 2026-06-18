/**
 * Unit tests for src/updates/manifest.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  compareUpdate,
  isNewer,
  UpdateManifest,
} from '../../../src/updates/manifest';

describe('isNewer', () => {
  it('returns true for a higher patch', () => {
    expect(isNewer('0.1.4', '0.1.3')).toBe(true);
  });

  it('returns false for an equal version', () => {
    expect(isNewer('0.1.3', '0.1.3')).toBe(false);
  });

  it('returns false for an older version', () => {
    expect(isNewer('0.1.2', '0.1.3')).toBe(false);
  });

  it('compares minor segments', () => {
    expect(isNewer('1.2.0', '1.1.9')).toBe(true);
    expect(isNewer('1.1.9', '1.2.0')).toBe(false);
  });

  it('compares major segments', () => {
    expect(isNewer('2.0.0', '1.9.9')).toBe(true);
    expect(isNewer('1.9.9', '2.0.0')).toBe(false);
  });

  it('treats missing segments as 0', () => {
    expect(isNewer('1.2', '1.2.0')).toBe(false);
    expect(isNewer('1.2.1', '1.2')).toBe(true);
  });

  it('ignores pre-release suffixes', () => {
    expect(isNewer('1.0.0-rc1', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.0-rc1')).toBe(false);
  });

  it('treats malformed input as 0.0.0', () => {
    expect(isNewer('garbage', '0.0.0')).toBe(false);
    expect(isNewer('garbage', '')).toBe(false);
  });
});

describe('parseManifest', () => {
  const valid = {
    version: '0.1.4',
    downloadUrl: 'https://example.com/delta.zip',
    sha256: 'a'.repeat(64),
    baseVersion: '1.99.0',
  };

  it('parses a valid manifest', () => {
    const m = parseManifest(valid);
    expect(m).not.toBeNull();
    expect(m!.version).toBe('0.1.4');
    expect(m!.sha256).toBe('a'.repeat(64));
    expect(m!.minAppVersion).toBeUndefined();
    expect(m!.releaseNotes).toBeUndefined();
  });

  it('normalizes uppercase sha256 to lowercase', () => {
    const m = parseManifest({ ...valid, sha256: 'A'.repeat(64) });
    expect(m!.sha256).toBe('a'.repeat(64));
  });

  it('accepts optional fields', () => {
    const m = parseManifest({
      ...valid,
      minAppVersion: '0.1.0',
      releaseNotes: 'fix things',
    });
    expect(m!.minAppVersion).toBe('0.1.0');
    expect(m!.releaseNotes).toBe('fix things');
  });

  it('returns null for non-object input', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('hello')).toBeNull();
    expect(parseManifest(42)).toBeNull();
    expect(parseManifest(undefined)).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    expect(parseManifest({ ...valid, version: undefined })).toBeNull();
    expect(parseManifest({ ...valid, downloadUrl: undefined })).toBeNull();
    expect(parseManifest({ ...valid, baseVersion: undefined })).toBeNull();
    expect(parseManifest({ ...valid, sha256: undefined })).toBeNull();
  });

  it('returns null when a required field is blank', () => {
    expect(parseManifest({ ...valid, version: '' })).toBeNull();
    expect(parseManifest({ ...valid, downloadUrl: '' })).toBeNull();
    expect(parseManifest({ ...valid, baseVersion: '  ' })).toBeNull();
  });

  it('rejects a sha256 that is not 64 hex chars', () => {
    expect(parseManifest({ ...valid, sha256: 'deadbeef' })).toBeNull();
    expect(parseManifest({ ...valid, sha256: 'g'.repeat(64) })).toBeNull(); // non-hex
    expect(parseManifest({ ...valid, sha256: 'a'.repeat(63) })).toBeNull(); // too short
  });
});

describe('compareUpdate', () => {
  const manifest: UpdateManifest = {
    version: '0.1.4',
    downloadUrl: 'https://example.com/delta.zip',
    sha256: 'a'.repeat(64),
    baseVersion: '1.99.0',
  };
  const base = { currentVersion: '0.1.3', currentBaseVersion: '1.99.0' };

  it('returns "available" for a newer, compatible delta', () => {
    expect(compareUpdate(manifest, base).kind).toBe('available');
  });

  it('returns "up-to-date" when the manifest version is not newer', () => {
    expect(compareUpdate({ ...manifest, version: '0.1.3' }, base).kind).toBe(
      'up-to-date',
    );
    expect(compareUpdate({ ...manifest, version: '0.1.2' }, base).kind).toBe(
      'up-to-date',
    );
  });

  it('returns "base-mismatch" when baseVersion differs', () => {
    expect(
      compareUpdate(manifest, { ...base, currentBaseVersion: '1.98.0' }).kind,
    ).toBe('base-mismatch');
  });

  it('returns "below-min-app" when the app is older than minAppVersion', () => {
    const m = { ...manifest, minAppVersion: '0.2.0' };
    expect(compareUpdate(m, base).kind).toBe('below-min-app');
  });

  it('passes when the app meets minAppVersion', () => {
    const m = { ...manifest, minAppVersion: '0.1.0' };
    expect(compareUpdate(m, base).kind).toBe('available');
  });

  it('checks base-mismatch before below-min-app', () => {
    const m = { ...manifest, minAppVersion: '0.2.0' };
    expect(
      compareUpdate(m, { ...base, currentBaseVersion: '1.98.0' }).kind,
    ).toBe('base-mismatch');
  });
});
