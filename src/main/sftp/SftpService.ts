import type { SFTPWrapper } from 'ssh2';
import { stat as fsStat } from 'node:fs';
import type { ConnectionRegistry, ConnectionRecord } from '../ssh/ConnectionRegistry.js';

/**
 * SFTP service over an existing ssh2 connection.
 *
 * The Android app has no file browser (out of scope there); this is net-new
 * for desktop. We reuse the live ssh2 `Client` from a connectionId (no second
 * connection) and pull an `SFTPWrapper` on demand via `client.sftp()`. The
 * wrapper is cached per connection for the session.
 *
 * All operations are promise-based. Methods reject on transport errors but
 * return typed results for expected "not found" cases (e.g. exists() returns
 * false rather than throwing).
 */

/** A directory entry, normalised from ssh2's stat output. */
export interface DirEntry {
  name: string;
  longname: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  modifyTime: number; // epoch ms
  accessTime: number; // epoch ms
  /** Rights in rwx string form, e.g. 'rwxr-xr-x'. */
  rights: { user: string; group: string; other: string };
  owner: number;
  group: number;
}

export interface FileStat {
  type: DirEntry['type'];
  size: number;
  modifyTime: number;
  accessTime: number;
}

export interface TransferProgress {
  /** Bytes transferred so far. */
  bytes: number;
  /** Total bytes, when known (file transfers); undefined for streams. */
  total?: number;
}

export class SftpService {
  /** Per-connection cached SFTP wrapper. */
  private readonly wrappers = new Map<string, Promise<SFTPWrapper>>();

  constructor(private readonly registry: ConnectionRegistry) {}

  /** Acquire (and cache) the SFTP wrapper for a connection. */
  private sftp(connectionId: string): Promise<SFTPWrapper> {
    const existing = this.wrappers.get(connectionId);
    if (existing) return existing;
    const rec = this.registry.require(connectionId);
    const promise = openSftp(rec).catch((err) => {
      // If acquisition failed, drop the cached rejection so the next call retries.
      this.wrappers.delete(connectionId);
      throw err;
    });
    this.wrappers.set(connectionId, promise);
    return promise;
  }

  /** Drop the cached wrapper for a connection (on disconnect). */
  evict(connectionId: string): void {
    void this.wrappers.get(connectionId)?.then((sftp) => {
      try {
        sftp.end();
      } catch {
        // ignore
      }
    });
    this.wrappers.delete(connectionId);
  }

  /** True if the path exists (any type). */
  async exists(connectionId: string, path: string): Promise<boolean> {
    const sftp = await this.sftp(connectionId);
    try {
      await stat(sftp, path);
      return true;
    } catch {
      return false;
    }
  }

  /** Stat a path. Rejects if it does not exist. */
  async stat(connectionId: string, path: string): Promise<FileStat> {
    const sftp = await this.sftp(connectionId);
    return toFileStat(await stat(sftp, path));
  }

  /** List directory entries. Rejects if the path is not a directory. */
  async list(connectionId: string, path: string): Promise<DirEntry[]> {
    const sftp = await this.sftp(connectionId);
    return new Promise<DirEntry[]>((resolve, reject) => {
      sftp.readdir(path, (err, list) => {
        if (err) {
          reject(err);
          return;
        }
        resolve((list ?? []).map((e) => toDirEntry(e.attrs, e.filename)));
      });
    });
  }

  /** Read a file as a UTF-8 string. */
  async readFile(connectionId: string, path: string): Promise<string> {
    const sftp = await this.sftp(connectionId);
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(path);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  /** Write a UTF-8 string to a file (overwrites). */
  async writeFile(connectionId: string, path: string, content: string): Promise<void> {
    const sftp = await this.sftp(connectionId);
    return new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(path);
      stream.on('error', reject);
      stream.on('close', () => resolve());
      stream.end(Buffer.from(content, 'utf8'));
    });
  }

  /** Create a directory. Rejects if it already exists. */
  async mkdir(connectionId: string, path: string): Promise<void> {
    const sftp = await this.sftp(connectionId);
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Rename/move a path. */
  async rename(connectionId: string, fromPath: string, toPath: string): Promise<void> {
    const sftp = await this.sftp(connectionId);
    return new Promise<void>((resolve, reject) => {
      sftp.rename(fromPath, toPath, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Delete a file. */
  async deleteFile(connectionId: string, path: string): Promise<void> {
    const sftp = await this.sftp(connectionId);
    return new Promise<void>((resolve, reject) => {
      sftp.unlink(path, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Remove an empty directory. */
  async rmdir(connectionId: string, path: string): Promise<void> {
    const sftp = await this.sftp(connectionId);
    return new Promise<void>((resolve, reject) => {
      sftp.rmdir(path, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Resolve a (possibly relative or symlink) path to an absolute one. */
  async realPath(connectionId: string, path: string): Promise<string> {
    const sftp = await this.sftp(connectionId);
    return new Promise<string>((resolve, reject) => {
      sftp.realpath(path, (err, abs) => (err ? reject(err) : resolve(abs)));
    });
  }

  /**
   * Upload a local file to a remote path. Emits progress via `onProgress`.
   * Uses ssh2's `fastPut` which handles chunked transfer + parallelism.
   */
  async upload(
    connectionId: string,
    localPath: string,
    remotePath: string,
    onProgress?: (p: TransferProgress) => void,
  ): Promise<void> {
    const sftp = await this.sftp(connectionId);
    const total = await localSize(localPath);
    return new Promise<void>((resolve, reject) => {
      sftp.fastPut(
        localPath,
        remotePath,
        { step: (transferred) => onProgress?.({ bytes: transferred, total }) },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  /**
   * Download a remote file to a local path. Emits progress via `onProgress`.
   */
  async download(
    connectionId: string,
    remotePath: string,
    localPath: string,
    onProgress?: (p: TransferProgress) => void,
  ): Promise<void> {
    const sftp = await this.sftp(connectionId);
    const statRes = toFileStat(await stat(sftp, remotePath));
    const total = statRes.size;
    return new Promise<void>((resolve, reject) => {
      sftp.fastGet(
        remotePath,
        localPath,
        { step: (transferred) => onProgress?.({ bytes: transferred, total }) },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function openSftp(rec: ConnectionRecord): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    rec.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

interface StatsLike {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtime: number;
  atime: number;
  mode: number;
  uid: number;
  gid: number;
  longname?: string;
}

function stat(sftp: SFTPWrapper, path: string): Promise<StatsLike> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) reject(err);
      else resolve(stats as unknown as StatsLike);
    });
  });
}

function toDirEntry(s: StatsLike, name?: string): DirEntry {
  const type: DirEntry['type'] = s.isDirectory()
    ? 'dir'
    : s.isSymbolicLink()
      ? 'symlink'
      : s.isFile()
        ? 'file'
        : 'other';
  return {
    name: name ?? '',
    longname: s.longname ?? '',
    type,
    size: s.size,
    modifyTime: s.mtime * 1000,
    accessTime: s.atime * 1000,
    rights: {
      user: modeToRwx((s.mode >> 6) & 7),
      group: modeToRwx((s.mode >> 3) & 7),
      other: modeToRwx(s.mode & 7),
    },
    owner: s.uid,
    group: s.gid,
  };
}

function toFileStat(s: StatsLike): FileStat {
  const type: DirEntry['type'] = s.isDirectory()
    ? 'dir'
    : s.isSymbolicLink()
      ? 'symlink'
      : s.isFile()
        ? 'file'
        : 'other';
  return { type, size: s.size, modifyTime: s.mtime * 1000, accessTime: s.atime * 1000 };
}

function modeToRwx(m: number): string {
  return (m & 4 ? 'r' : '-') + (m & 2 ? 'w' : '-') + (m & 1 ? 'x' : '-');
}

function localSize(path: string): Promise<number> {
  return new Promise((resolve) => {
    fsStat(path, (err, st) => resolve(err || !st ? 0 : st.size));
  });
}
