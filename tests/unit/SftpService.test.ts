import { Readable } from 'node:stream';
import type { Client } from 'ssh2';
import { describe, expect, it } from 'vitest';
import { SftpService } from '@main/sftp/SftpService';
import { ConnectionRegistry } from '@main/ssh/ConnectionRegistry';

/**
 * Unit tests for `SftpService.readBinary` — the binary sibling of
 * `readFile`, which decodes UTF-8 and so cannot carry an image.
 *
 * The real SFTP round-trip is covered by
 * tests/integration/SftpService.integration.test.ts against a container.
 * What matters here is the part that has no business needing Docker: the
 * size ceiling, and that it is applied off the stat rather than after
 * dragging the file over the wire.
 *
 * The fake `SFTPWrapper` is deliberately a thin slice of a very large
 * ssh2 surface (the same approach as the fake in AttachmentStager.test.ts).
 */

interface FakeFile {
  type: 'file' | 'dir' | 'symlink';
  /** Bytes the read stream will emit. Defaults to a single empty chunk. */
  chunks?: Buffer[];
  /** Size `stat` reports. Defaults to the real total of `chunks`. */
  reportedSize?: number;
}

interface Harness {
  sftp: SftpService;
  connectionId: string;
  /** Paths whose read stream was actually opened. */
  streamed: string[];
}

function harnessFor(files: Record<string, FakeFile>): Harness {
  const streamed: string[] = [];

  const wrapper = {
    stat(path: string, cb: (err: Error | null, stats?: unknown) => void): void {
      const file = files[path];
      if (!file) {
        cb(Object.assign(new Error(`No such file: ${path}`), { code: 'ENOENT' }));
        return;
      }
      const chunks = file.chunks ?? [];
      const size = file.reportedSize ?? chunks.reduce((n, c) => n + c.length, 0);
      cb(null, {
        isFile: () => file.type === 'file',
        isDirectory: () => file.type === 'dir',
        isSymbolicLink: () => file.type === 'symlink',
        size,
        mtime: 0,
        atime: 0,
        mode: 0o644,
        uid: 0,
        gid: 0,
      });
    },
    createReadStream(path: string): Readable {
      streamed.push(path);
      // objectMode iteration over Buffers: each chunk arrives intact, which
      // is all the running-total guard cares about.
      return Readable.from(files[path]?.chunks ?? []);
    },
    end(): void {
      // no-op
    },
  };

  const client = {
    sftp(cb: (err: Error | null, sftp: unknown) => void): void {
      cb(null, wrapper);
    },
  };

  const registry = new ConnectionRegistry();
  const connectionId = registry.register({
    client: client as unknown as Client,
    label: 'testuser@fake:22',
    host: 'fake',
    port: 22,
    user: 'testuser',
    knownHosts: null,
    connectedAt: 0,
  });

  return { sftp: new SftpService(registry), connectionId, streamed };
}

const CAP = 1024;

describe('SftpService.readBinary', () => {
  it('returns the raw bytes of a remote file', async () => {
    // A leading PNG signature: the exact byte range `readFile`'s UTF-8
    // decode would replace with U+FFFD.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
    const h = harnessFor({ '/home/me/shot.png': { type: 'file', chunks: [png] } });

    const bytes = await h.sftp.readBinary(h.connectionId, '/home/me/shot.png', CAP);

    expect(Buffer.compare(bytes, png)).toBe(0);
  });

  it('joins multiple chunks in order', async () => {
    const h = harnessFor({
      '/f': {
        type: 'file',
        chunks: [Buffer.from('AB'), Buffer.from('CD'), Buffer.from('EF')],
      },
    });
    const bytes = await h.sftp.readBinary(h.connectionId, '/f', CAP);
    expect(bytes.toString('utf8')).toBe('ABCDEF');
  });

  it('reads an empty file as zero bytes', async () => {
    const h = harnessFor({ '/empty': { type: 'file', chunks: [] } });
    expect(await h.sftp.readBinary(h.connectionId, '/empty', CAP)).toHaveLength(0);
  });

  it('accepts a file exactly at the cap', async () => {
    const h = harnessFor({ '/exact': { type: 'file', chunks: [Buffer.alloc(CAP, 1)] } });
    expect(await h.sftp.readBinary(h.connectionId, '/exact', CAP)).toHaveLength(CAP);
  });

  // --- refusals -----------------------------------------------------------

  it('rejects an oversized file off the stat, without opening a stream', async () => {
    const h = harnessFor({
      '/big': { type: 'file', chunks: [Buffer.alloc(CAP + 1)] },
    });

    await expect(h.sftp.readBinary(h.connectionId, '/big', CAP)).rejects.toThrow(
      /\/big is 0\.0 MB; the limit is 0\.0 MB/,
    );
    // The point of stat-ing first: nothing crossed the wire.
    expect(h.streamed).toEqual([]);
  });

  it('names both sizes in megabytes when refusing', async () => {
    const h = harnessFor({
      // Report a size without allocating it — the stat is what is checked.
      '/huge': { type: 'file', chunks: [], reportedSize: 4 * 1024 * 1024 },
    });
    await expect(
      h.sftp.readBinary(h.connectionId, '/huge', 1024 * 1024),
    ).rejects.toThrow(/is 4\.0 MB; the limit is 1\.0 MB/);
  });

  it('still refuses a file that grew after the stat', async () => {
    // The host under-reports (or the file is being appended to): the
    // running total has to hold the ceiling on its own.
    const h = harnessFor({
      '/growing': {
        type: 'file',
        chunks: [Buffer.alloc(CAP), Buffer.alloc(CAP)],
        reportedSize: 10,
      },
    });

    await expect(h.sftp.readBinary(h.connectionId, '/growing', CAP)).rejects.toThrow(
      /the limit is/,
    );
    expect(h.streamed).toEqual(['/growing']);
  });

  it('rejects a directory', async () => {
    const h = harnessFor({ '/home/me': { type: 'dir' } });
    await expect(h.sftp.readBinary(h.connectionId, '/home/me', CAP)).rejects.toThrow(
      /Not a regular file: \/home\/me/,
    );
    expect(h.streamed).toEqual([]);
  });

  it('rejects a missing file', async () => {
    const h = harnessFor({});
    await expect(h.sftp.readBinary(h.connectionId, '/nope.png', CAP)).rejects.toThrow(
      /No such file: \/nope\.png/,
    );
  });

  it('rejects an unknown connection', async () => {
    const h = harnessFor({ '/f': { type: 'file', chunks: [Buffer.from('x')] } });
    await expect(h.sftp.readBinary('conn-nope', '/f', CAP)).rejects.toThrow();
  });
});
