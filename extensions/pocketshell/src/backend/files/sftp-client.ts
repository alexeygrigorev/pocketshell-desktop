/**
 * SFTP client for PocketShell Desktop.
 *
 * Wraps an active SSH connection's SFTP subsystem to provide async file
 * system operations on the remote host. Built on ssh2's SFTPWrapper.
 */

import type { SshConnection } from '../ssh/connection/ssh-client';
import type { SFTPWrapper, Stats, FileEntryWithStats } from 'ssh2';
import type { RemoteFileEntry, RemoteFileStat } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a numeric file mode to a Unix-style permission string (e.g. 'rwxr-xr-x').
 */
function modeToPermissions(mode: number): string {
  const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  const owner = perms[(mode >>> 6) & 0o7];
  const group = perms[(mode >>> 3) & 0o7];
  const other = perms[mode & 0o7];
  return `${owner}${group}${other}`;
}

/**
 * Convert an ssh2 FileEntryWithStats to our RemoteFileEntry.
 */
function toRemoteFileEntry(entry: FileEntryWithStats, dirPath: string): RemoteFileEntry {
  const { filename, attrs } = entry;
  // Ensure dirPath does not have a trailing slash for consistent joining
  const normalizedDir = dirPath.endsWith('/') ? dirPath.slice(0, -1) : dirPath;
  return {
    name: filename,
    path: `${normalizedDir}/${filename}`,
    isDirectory: attrs.isDirectory(),
    isFile: attrs.isFile(),
    isSymbolicLink: attrs.isSymbolicLink(),
    size: attrs.size,
    modifiedAt: attrs.mtime * 1000, // ssh2 returns seconds, we store ms
    permissions: modeToPermissions(attrs.mode),
  };
}

/**
 * Convert an ssh2 Stats object to our RemoteFileStat.
 */
function toRemoteFileStat(stats: Stats): RemoteFileStat {
  return {
    mode: stats.mode,
    size: stats.size,
    modifiedAt: stats.mtime * 1000,
    isDirectory: () => stats.isDirectory(),
    isFile: () => stats.isFile(),
    isSymbolicLink: () => stats.isSymbolicLink(),
  };
}

// ---------------------------------------------------------------------------
// SftpClient
// ---------------------------------------------------------------------------

/**
 * High-level SFTP client that wraps an active SSH connection.
 *
 * Opens an SFTP subsystem channel over the connection and provides
 * async methods for file and directory operations.
 */
export class SftpClient {
  private connection: SshConnection;
  private sftp: SFTPWrapper | null = null;

  constructor(connection: SshConnection) {
    this.connection = connection;
  }

  /** Whether the SFTP channel is currently open. */
  get connected(): boolean {
    return this.sftp !== null;
  }

  // -- Lifecycle ---------------------------------------------------------------

  /**
   * Open the SFTP subsystem on the underlying SSH connection.
   * Must be called before any file operations.
   */
  async connect(): Promise<void> {
    if (this.sftp) {
      throw new Error('SFTP session already open');
    }
    this.sftp = await this.connection.sftp();
  }

  /**
   * Close the SFTP channel. Idempotent.
   */
  disconnect(): void {
    if (this.sftp) {
      try {
        this.sftp.end();
      } catch {
        // Swallow teardown errors
      }
      this.sftp = null;
    }
  }

  // -- Directory operations ----------------------------------------------------

  /**
   * List directory contents.
   */
  async readdir(path: string): Promise<RemoteFileEntry[]> {
    const sftp = this.requireSftp();
    const entries = await this.promisify<FileEntryWithStats[]>((cb) =>
      sftp.readdir(path, cb),
    );
    return entries.map((e) => toRemoteFileEntry(e, path));
  }

  /**
   * Get file/directory metadata.
   */
  async stat(path: string): Promise<RemoteFileStat> {
    const sftp = this.requireSftp();
    const stats = await this.promisify<Stats>((cb) => sftp.stat(path, cb));
    return toRemoteFileStat(stats);
  }

  /**
   * Get file/directory metadata without following symlinks.
   */
  async lstat(path: string): Promise<RemoteFileStat> {
    const sftp = this.requireSftp();
    const stats = await this.promisify<Stats>((cb) => sftp.lstat(path, cb));
    return toRemoteFileStat(stats);
  }

  // -- File operations ---------------------------------------------------------

  /**
   * Read an entire file and return its contents as a Buffer.
   */
  async readFile(path: string): Promise<Buffer> {
    const sftp = this.requireSftp();
    return this.promisify<Buffer>((cb) => sftp.readFile(path, cb));
  }

  /**
   * Read an entire file and return its contents as a UTF-8 string.
   */
  async readFileText(path: string): Promise<string> {
    const buf = await this.readFile(path);
    return buf.toString('utf-8');
  }

  /**
   * Write data to a file, creating or overwriting it.
   */
  async writeFile(path: string, data: Buffer | string): Promise<void> {
    const sftp = this.requireSftp();
    await this.promisifyVoid((cb) => sftp.writeFile(path, data, cb));
  }

  /**
   * Create a directory.
   */
  async mkdir(path: string): Promise<void> {
    const sftp = this.requireSftp();
    await this.promisifyVoid((cb) => sftp.mkdir(path, cb));
  }

  /**
   * Delete a file.
   */
  async unlink(path: string): Promise<void> {
    const sftp = this.requireSftp();
    await this.promisifyVoid((cb) => sftp.unlink(path, cb));
  }

  /**
   * Remove an empty directory.
   */
  async rmdir(path: string): Promise<void> {
    const sftp = this.requireSftp();
    await this.promisifyVoid((cb) => sftp.rmdir(path, cb));
  }

  /**
   * Rename (move) a file or directory.
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = this.requireSftp();
    await this.promisifyVoid((cb) => sftp.rename(oldPath, newPath, cb));
  }

  /**
   * Check whether a path exists on the remote host.
   *
   * ssh2's `exists` uses a callback with a boolean rather than an error-first
   * pattern. Returns true if the path exists, false otherwise.
   */
  async exists(path: string): Promise<boolean> {
    const sftp = this.requireSftp();
    return new Promise((resolve) => {
      sftp.exists(path, (exists) => {
        resolve(exists);
      });
    });
  }

  /**
   * Resolve a path to its absolute canonical form.
   */
  async realpath(path: string): Promise<string> {
    const sftp = this.requireSftp();
    return this.promisify<string>((cb) => sftp.realpath(path, cb));
  }

  // -- Streaming ---------------------------------------------------------------

  /**
   * Create a readable stream for a remote file.
   * Optionally specify byte range with `start` and `end` (inclusive).
   */
  async createReadStream(
    path: string,
    options?: { start?: number; end?: number },
  ): Promise<NodeJS.ReadableStream> {
    const sftp = this.requireSftp();
    const streamOpts: any = {};
    if (options?.start !== undefined) streamOpts.start = options.start;
    if (options?.end !== undefined) streamOpts.end = options.end;
    return sftp.createReadStream(path, streamOpts);
  }

  /**
   * Create a writable stream for a remote file.
   */
  async createWriteStream(path: string): Promise<NodeJS.WritableStream> {
    const sftp = this.requireSftp();
    return sftp.createWriteStream(path);
  }

  // -- Internal helpers --------------------------------------------------------

  private requireSftp(): SFTPWrapper {
    if (!this.sftp) {
      throw new Error('SFTP session not open. Call connect() first.');
    }
    return this.sftp;
  }

  /**
   * Promisify an error-first callback-style SFTP method.
   */
  private promisify<T>(fn: (cb: (err: Error | null | undefined, result: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      fn((err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  /**
   * Promisify a void-returning callback-style SFTP method (no result parameter).
   */
  private promisifyVoid(fn: (cb: (err?: Error | null) => void) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      fn((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
