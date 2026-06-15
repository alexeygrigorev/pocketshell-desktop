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
export {
  REMOTE_FILE_IMAGE_PREVIEW_LIMIT,
  REMOTE_FILE_TEXT_PREVIEW_LIMIT,
  buildRemoteFileReviewPrompt,
  classifyRemoteFileEntryPreview,
  classifyRemoteFilePreview,
  classifyRemoteFileStatPreview,
  formatBytes,
  looksLikeBinarySample,
} from './remote-file-preview';
export type {
  RemoteFilePreviewInput,
  RemoteFilePreviewKind,
  RemoteFilePreviewPlan,
  RemoteFileReviewPromptInput,
} from './remote-file-preview';
export type { RemoteFileEntry, RemoteFileStat, FileBrowserOptions } from './types';
