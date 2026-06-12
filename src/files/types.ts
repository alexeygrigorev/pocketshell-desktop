/**
 * Types for the remote file browser.
 *
 * Defines data structures for representing remote file system entries,
 * file metadata, and browser configuration.
 */

// ---------------------------------------------------------------------------
// RemoteFileEntry
// ---------------------------------------------------------------------------

/**
 * A single entry in a remote directory listing.
 */
export interface RemoteFileEntry {
  /** File name (no path). */
  name: string;

  /** Full absolute path. */
  path: string;

  /** Whether this entry is a directory. */
  isDirectory: boolean;

  /** Whether this entry is a regular file. */
  isFile: boolean;

  /** Whether this entry is a symbolic link. */
  isSymbolicLink: boolean;

  /** Size in bytes. */
  size: number;

  /** Last modified time as a millisecond timestamp. */
  modifiedAt: number;

  /** Permission string, e.g. 'rwxr-xr-x'. */
  permissions?: string;
}

// ---------------------------------------------------------------------------
// RemoteFileStat
// ---------------------------------------------------------------------------

/**
 * Metadata about a remote file or directory.
 */
export interface RemoteFileStat {
  mode: number;
  size: number;
  modifiedAt: number;

  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

// ---------------------------------------------------------------------------
// FileBrowserOptions
// ---------------------------------------------------------------------------

/**
 * Configuration options for the file browser.
 */
export interface FileBrowserOptions {
  /** Initial directory (defaults to home). */
  rootPath?: string;

  /** Whether to show hidden (dot) files. Default: false. */
  showHidden?: boolean;
}
