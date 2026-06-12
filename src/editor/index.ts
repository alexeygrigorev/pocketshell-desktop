/**
 * Remote file editing system — public API.
 *
 * Re-exports all editor modules for convenient consumption.
 */

export { RemoteDocument } from './remote-document';
export type { Event } from './remote-document';

export { DocumentManager } from './document-manager';

export { detectLanguage } from './language-detection';

export { RemoteSaveManager } from './save-manager';

export type {
  RemoteFileMetadata,
  RemoteDocumentSaveResult,
  LanguageDetection,
  SftpAdapter,
} from './types';
