/**
 * Unit tests for src/updates/verifier.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { sha256OfFile, safeStrEqual } from '../../../src/updates/verifier';

describe('sha256OfFile', () => {
  it('computes the sha256 of a file', async () => {
    const tmp = path.join(os.tmpdir(), `vrf-${Date.now()}.bin`);
    const data = Buffer.from('hello pocketshell');
    fs.writeFileSync(tmp, data);
    try {
      const expected = createHash('sha256').update(data).digest('hex');
      await expect(sha256OfFile(tmp)).resolves.toBe(expected);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('computes the sha256 of an empty file', async () => {
    const tmp = path.join(os.tmpdir(), `vrf-empty-${Date.now()}.bin`);
    fs.writeFileSync(tmp, Buffer.alloc(0));
    try {
      const expected = createHash('sha256').digest('hex');
      await expect(sha256OfFile(tmp)).resolves.toBe(expected);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('rejects for a missing file', async () => {
    await expect(
      sha256OfFile(path.join(os.tmpdir(), `nope-${Date.now()}.bin`)),
    ).rejects.toBeDefined();
  });
});

describe('safeStrEqual', () => {
  it('returns true for identical strings', () => {
    expect(safeStrEqual('abc', 'abc')).toBe(true);
  });

  it('returns true ignoring case', () => {
    expect(safeStrEqual('ABCDef', 'abcdef')).toBe(true);
  });

  it('returns false for different strings of equal length', () => {
    expect(safeStrEqual('abcdef', 'abcdez')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(safeStrEqual('abc', 'abcd')).toBe(false);
  });

  it('handles nullish input', () => {
    expect(safeStrEqual(undefined as unknown as string, '')).toBe(true);
    expect(safeStrEqual(null as unknown as string, 'x')).toBe(false);
  });
});
