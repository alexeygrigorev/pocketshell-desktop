/**
 * Remote files module for PocketShell Desktop.
 *
 * Re-exports the SFTP client, file browser, and polling watcher so consumers
 * can import everything from a single entry point.
 */

export { SftpClient } from './sftp-client';
export { FileBrowser } from './file-browser';
export type { NavigateCallback } from './file-browser';
export { RemoteFileWatcher } from './file-watcher';
export type { FileWatchCallback } from './file-watcher';
export type {
  RemoteFileEntry,
  RemoteFileStat,
  FileBrowserOptions,
} from './types';
