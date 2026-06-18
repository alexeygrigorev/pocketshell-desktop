/**
 * Unit tests for src/updates/updater.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { checkForUpdate, applyUpdate, UpdateManifest } from '../../../src/updates/updater';
import { ZipBuilder } from './zip-builder';

/** fetch that serves a JSON body. */
function jsonFetch(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe('checkForUpdate', () => {
  const opts = { currentVersion: '0.1.3', currentBaseVersion: '1.99.0' };

  const availableManifest = {
    version: '0.1.4',
    downloadUrl: 'https://example.com/delta.zip',
    sha256: 'a'.repeat(64),
    baseVersion: '1.99.0',
  };

  it('returns "available" with the manifest for a newer delta', async () => {
    const r = await checkForUpdate('https://m', opts, jsonFetch(availableManifest));
    expect(r.status).toBe('available');
    expect(r.manifest).toBeDefined();
    expect(r.manifest!.version).toBe('0.1.4');
  });

  it('returns "up-to-date" when the manifest version is not newer', async () => {
    const r = await checkForUpdate(
      'https://m',
      opts,
      jsonFetch({ ...availableManifest, version: '0.1.3' }),
    );
    expect(r.status).toBe('up-to-date');
  });

  it('returns "base-mismatch" for a wrong base version', async () => {
    const r = await checkForUpdate(
      'https://m',
      opts,
      jsonFetch({ ...availableManifest, baseVersion: '1.98.0' }),
    );
    expect(r.status).toBe('base-mismatch');
  });

  it('returns "below-min-app" when minAppVersion exceeds current', async () => {
    const r = await checkForUpdate(
      'https://m',
      opts,
      jsonFetch({ ...availableManifest, minAppVersion: '0.2.0' }),
    );
    expect(r.status).toBe('below-min-app');
  });

  it('returns "check-failed" on a network error', async () => {
    const failing: typeof fetch = async () => {
      throw new Error('offline');
    };
    const r = await checkForUpdate('https://m', opts, failing);
    expect(r.status).toBe('check-failed');
  });

  it('returns "check-failed" on a non-2xx response', async () => {
    const r = await checkForUpdate('https://m', opts, jsonFetch({}, 503));
    expect(r.status).toBe('check-failed');
  });

  it('returns "check-failed" on an unparseable/invalid manifest', async () => {
    const r = await checkForUpdate('https://m', opts, jsonFetch({ nope: true }));
    expect(r.status).toBe('check-failed');
  });

  it('returns "check-failed" on invalid JSON', async () => {
    const bad: typeof fetch = async () =>
      new Response('not json{', { status: 200 });
    const r = await checkForUpdate('https://m', opts, bad);
    expect(r.status).toBe('check-failed');
  });
});

describe('applyUpdate', () => {
  let workDir: string;
  let targetDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'));
    targetDir = path.join(workDir, 'extension');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'old.txt'), 'old');
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('downloads, verifies, and installs when the sha matches', async () => {
    const zipBuf = new ZipBuilder()
      .store('package.json', '{"version":"0.1.4"}')
      .build();
    const sha = createHash('sha256').update(zipBuf).digest('hex');

    const manifest: UpdateManifest = {
      version: '0.1.4',
      downloadUrl: 'https://example.com/delta.zip',
      sha256: sha,
      baseVersion: '1.99.0',
    };

    const fetchImpl: typeof fetch = async () =>
      new Response(zipBuf, { status: 200 });

    const result = await applyUpdate(manifest, targetDir, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.backupPath).toBe(`${targetDir}.old`);
    expect(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8')).toBe(
      '{"version":"0.1.4"}',
    );
    // Old contents preserved in the backup.
    expect(fs.existsSync(path.join(result.backupPath!, 'old.txt'))).toBe(true);
  });

  it('throws on a sha256 mismatch and leaves the target intact', async () => {
    const zipBuf = new ZipBuilder().store('package.json', '{}').build();
    const manifest: UpdateManifest = {
      version: '0.1.4',
      downloadUrl: 'https://example.com/delta.zip',
      sha256: 'b'.repeat(64), // wrong on purpose
      baseVersion: '1.99.0',
    };
    const fetchImpl: typeof fetch = async () =>
      new Response(zipBuf, { status: 200 });

    await expect(applyUpdate(manifest, targetDir, { fetchImpl })).rejects.toThrow(
      /sha256 mismatch/,
    );

    // Original target untouched.
    expect(fs.readFileSync(path.join(targetDir, 'old.txt'), 'utf8')).toBe('old');
    expect(fs.existsSync(`${targetDir}.new`)).toBe(false);
    expect(fs.existsSync(`${targetDir}.old`)).toBe(false);
  });
});
