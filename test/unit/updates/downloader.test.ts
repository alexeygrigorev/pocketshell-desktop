/**
 * Unit tests for src/updates/downloader.ts.
 *
 * Uses a fake fetchImpl (built from a real Response over a known buffer) to
 * avoid network I/O.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { downloadToFile } from '../../../src/updates/downloader';

/** Build a fetchImpl that resolves to a Response carrying `payload`. */
function fakeFetch(payload: Buffer, status = 200): typeof fetch {
  return async () =>
    new Response(payload, { status, statusText: status === 200 ? 'OK' : 'Err' });
}

describe('downloadToFile', () => {
  it('writes the file and returns the correct sha256', async () => {
    const payload = Buffer.from('the quick brown fox');
    const dest = path.join(os.tmpdir(), `dl-${Date.now()}.bin`);
    const expected = createHash('sha256').update(payload).digest('hex');
    try {
      const sha = await downloadToFile('https://example.com/x', dest, fakeFetch(payload));
      expect(sha).toBe(expected);
      expect(fs.readFileSync(dest)).toEqual(payload);
    } finally {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    }
  });

  it('creates the parent directory if missing', async () => {
    const payload = Buffer.from('x');
    const dir = path.join(os.tmpdir(), `dl-dir-${Date.now()}`, 'nested');
    const dest = path.join(dir, 'out.bin');
    try {
      await downloadToFile('https://example.com/x', dest, fakeFetch(payload));
      expect(fs.existsSync(dest)).toBe(true);
    } finally {
      fs.rmSync(path.dirname(path.dirname(dest)), { recursive: true, force: true });
    }
  });

  it('handles a large payload (streamed chunks)', async () => {
    const payload = Buffer.alloc(256 * 1024, 7); // 256 KiB
    const dest = path.join(os.tmpdir(), `dl-big-${Date.now()}.bin`);
    const expected = createHash('sha256').update(payload).digest('hex');
    try {
      const sha = await downloadToFile('https://example.com/x', dest, fakeFetch(payload));
      expect(sha).toBe(expected);
      expect(fs.statSync(dest).size).toBe(payload.length);
    } finally {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    }
  });

  it('cleans up the partial file on HTTP error', async () => {
    const dest = path.join(os.tmpdir(), `dl-err-${Date.now()}.bin`);
    await expect(
      downloadToFile('https://example.com/x', dest, fakeFetch(Buffer.from('no'), 500)),
    ).rejects.toThrow(/HTTP 500/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('cleans up on a network failure', async () => {
    const dest = path.join(os.tmpdir(), `dl-net-${Date.now()}.bin`);
    const failing: typeof fetch = async () => {
      throw new Error('connection refused');
    };
    await expect(
      downloadToFile('https://example.com/x', dest, failing),
    ).rejects.toThrow(/network/);
    expect(fs.existsSync(dest)).toBe(false);
  });
});
