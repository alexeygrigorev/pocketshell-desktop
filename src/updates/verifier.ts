/**
 * SHA-256 verification helpers for the extension-delta updater.
 *
 * Pure backend logic: no `vscode` import. Uses only `node:crypto` and
 * `node:fs`, so it runs identically under Node (unit tests) and inside the
 * Electron extension host.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Compute the lowercase hex sha256 of a file by streaming it.
 *
 * Kept separate from the downloader so the installer can re-verify an
 * already-downloaded artifact before swapping it in.
 */
export async function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) =>
      hash.update(chunk as Buffer),
    );
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Constant-time-ish equality for two hex digest strings.
 *
 * Both inputs are normalized to lowercase before comparison. Returns false for
 * mismatched lengths (which cannot be equal). The comparison walks the full
 * length even after a mismatch so timing does not leak the position of the
 * first differing byte. This is a pragmatic mitigation, not a cryptographic
 * guarantee against a local attacker.
 */
export function safeStrEqual(a: string, b: string): boolean {
  const x = (a ?? '').toLowerCase();
  const y = (b ?? '').toLowerCase();
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) {
    diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  }
  return diff === 0;
}
