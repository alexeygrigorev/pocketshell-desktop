/**
 * Streaming downloader for the extension-delta updater.
 *
 * Downloads a delta artifact to a file while incrementally computing its
 * sha256, so the caller can verify integrity without re-reading the file.
 * Pure backend logic: no `vscode` import. Uses the global `fetch` (available in
 * Node 24 and the Electron extension host) by default; the injectable
 * `fetchImpl` makes it unit-testable without touching the network.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Signature compatible with the global `fetch`. */
export type FetchImpl = typeof fetch;

/**
 * Download `url` to `destPath`, returning the lowercase hex sha256 of the
 * downloaded bytes.
 *
 * - The parent directory of `destPath` is created if missing.
 * - Bytes are streamed to disk and hashed incrementally; memory use is O(chunk)
 *   regardless of file size.
 * - On any error (network failure, non-2xx status, write error) the partial
 *   file is deleted and the error is rethrown.
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const hash = createHash('sha256');
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw new Error(`Update download failed (network): ${errMsg(err)}`);
  }

  if (!response.ok) {
    throw new Error(
      `Update download failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  if (response.body === null || response.body === undefined) {
    throw new Error('Update download failed: response has no body');
  }

  // Write to a temp sibling file first, then rename, so a crashed download
  // never leaves a half-written file at destPath.
  const tmpPath = `${destPath}.part-${process.pid}-${Date.now()}`;
  const out = fs.createWriteStream(tmpPath);

  try {
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(value);
        await writeChunk(out, value);
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err: NodeJS.ErrnoException | null) =>
        err ? reject(err) : resolve(),
      );
    });
    fs.renameSync(tmpPath, destPath);
    return hash.digest('hex');
  } catch (err) {
    out.destroy();
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup; the original error is more important.
    }
    throw err;
  }
}

/** Write a chunk to the stream, resolving once it has flushed. */
function writeChunk(stream: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, err => (err ? reject(err) : resolve()));
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
