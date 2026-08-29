import { describe, expect, it } from 'vitest';
import {
  checkForUpdate,
  isNewerRelease,
  pickAsset,
  type CheckInput,
} from '@main/release/ReleaseChecker';

/**
 * The release checker decides whether the user gets nagged, so its edges are
 * the tests: a strictly-older/current/newer tag, unreadable tags, asset
 * matching per platform/arch, and the contract that a FAILED CHECK IS AN
 * ANSWER — reason attached, never a thrown error, never a silent null.
 */

const V = '0.1.2';

const input = (over: Partial<CheckInput> = {}): CheckInput => ({
  currentVersion: V,
  platform: 'win32',
  arch: 'x64',
  fetcher: async () => new Response('{}', { status: 200 }),
  ...over,
});

const releasePayload = (assets: { name: string; browser_download_url: string }[], tag = 'v0.1.3') =>
  new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/alexeygrigorev/pocketshell-desktop/releases/tag/${tag}`, assets }), {
    status: 200,
  });

describe('isNewerRelease', () => {
  it('is true only for a strictly newer dotted version', () => {
    expect(isNewerRelease('v0.1.3', '0.1.2')).toBe(true);
    expect(isNewerRelease('v0.2.0', '0.1.2')).toBe(true);
    expect(isNewerRelease('v1.0', '0.9.9')).toBe(true);
    expect(isNewerRelease('v0.1.2', '0.1.2')).toBe(false);
    expect(isNewerRelease('v0.1.1', '0.1.2')).toBe(false);
  });

  it('ignores a short tag rather than reading a missing row as newer', () => {
    // v0.1 vs 0.1.2: row 2 is missing on the tag and defaults to 0, so
    // 0.1 == 0.1.0 is OLDER than 0.1.2. The comparison is row-wise.
    expect(isNewerRelease('v0.1', '0.1.2')).toBe(false);
  });

  it('answers false for tags it cannot read instead of guessing', () => {
    expect(isNewerRelease('nightly', '0.1.2')).toBe(false);
    expect(isNewerRelease('v0.1.3-beta', '0.1.2')).toBe(false);
  });
});

describe('pickAsset', () => {
  const assets = [
    { name: 'PocketShell-0.1.3-win-x64.zip', downloadUrl: 'https://x/win-x64.zip' },
    { name: 'PocketShell-0.1.3-win-arm64.zip', downloadUrl: 'https://x/win-arm64.zip' },
    { name: 'PocketShell-0.1.3-mac.zip', downloadUrl: 'https://x/mac.zip' },
    { name: 'PocketShell-0.1.3-arm64-mac.zip', downloadUrl: 'https://x/arm64-mac.zip' },
    { name: 'PocketShell-0.1.3.AppImage', downloadUrl: 'https://x.AppImage' },
    { name: 'PocketShell-0.1.3-arm64.AppImage', downloadUrl: 'https://x/arm64.AppImage' },
    { name: 'pocketshell-desktop_0.1.3_amd64.deb', downloadUrl: 'https://x.deb' },
  ];

  it('picks the zip for this Windows arch', () => {
    expect(pickAsset(assets, 'win32', 'x64')?.downloadUrl).toBe('https://x/win-x64.zip');
    expect(pickAsset(assets, 'win32', 'arm64')?.downloadUrl).toBe('https://x/win-arm64.zip');
  });

  it('picks the mac zip for this Mac arch', () => {
    expect(pickAsset(assets, 'darwin', 'arm64')?.downloadUrl).toBe('https://x/arm64-mac.zip');
    expect(pickAsset(assets, 'darwin', 'x64')?.downloadUrl).toBe('https://x/mac.zip');
  });

  it('prefers the AppImage on Linux, per arch', () => {
    expect(pickAsset(assets, 'linux', 'x64')?.downloadUrl).toBe('https://x.AppImage');
    expect(pickAsset(assets, 'linux', 'arm64')?.downloadUrl).toBe('https://x/arm64.AppImage');
  });

  it('answers null when the release has nothing for this machine', () => {
    expect(pickAsset([], 'win32', 'arm64')).toBeNull();
    expect(
      pickAsset([{ name: 'pocketshell-0.4.45-debug.apk', downloadUrl: 'https://x.apk' }], 'win32', 'x64'),
    ).toBeNull();
  });
});

describe('checkForUpdate', () => {
  it('offers the asset when the release is newer', async () => {
    const result = await checkForUpdate(
      input({
        fetcher: async () =>
          releasePayload([
            { name: 'PocketShell-0.1.3-win-x64.zip', browser_download_url: 'https://x/win-x64.zip' },
          ]),
      }),
    );
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.tagName).toBe('v0.1.3');
      expect(result.currentVersion).toBe(V);
      expect(result.downloadUrl).toBe('https://x/win-x64.zip');
      expect(result.notesUrl).toContain('/releases/tag/v0.1.3');
    }
  });

  it('answers up-to-date when the tag is not newer', async () => {
    const result = await checkForUpdate(
      input({ fetcher: async () => releasePayload([], 'v0.1.2') }),
    );
    expect(result).toEqual({ status: 'up-to-date', currentVersion: V });
  });

  it('answers up-to-date for an OLDER release', async () => {
    const result = await checkForUpdate(
      input({ fetcher: async () => releasePayload([], 'v0.0.9') }),
    );
    expect(result.status).toBe('up-to-date');
  });

  it('classifies a non-200 as failed WITH a reason', async () => {
    const result = await checkForUpdate(
      input({ fetcher: async () => new Response('rate limited', { status: 403 }) }),
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toContain('403');
  });

  it('classifies a broken payload as failed instead of throwing', async () => {
    const result = await checkForUpdate(
      input({ fetcher: async () => new Response('not json at all', { status: 200 }) }),
    );
    expect(result.status).toBe('failed');
  });

  it('classifies a missing asset for this machine as failed, not silent', async () => {
    const result = await checkForUpdate(
      input({ fetcher: async () => releasePayload([{ name: 'pocketshell-0.4.45-debug.apk', browser_download_url: 'https://x.apk' }]) }),
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toContain('win32/x64');
  });

  it('never throws on a network error', async () => {
    const result = await checkForUpdate(
      input({ fetcher: async () => { throw new Error('ENOTREACH'); } }),
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toContain('ENOTREACH');
  });
});
