/**
 * Files module barrel export.
 *
 * Re-exports all public APIs from the files submodules.
 */

export { SftpClient } from './sftp-client';
export { FileBrowser, remoteFileUriParts, resolveFileBrowserStartDirectory } from './file-browser';
export type { NavigateCallback, RemoteFileBrowseTarget, RemoteFileUriParts } from './file-browser';
export { RemoteFileWatcher } from './file-watcher';
export type { FileWatchCallback } from './file-watcher';
export type { RemoteFileEntry, RemoteFileStat, FileBrowserOptions } from './types';
