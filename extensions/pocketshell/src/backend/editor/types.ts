/**
 * Types for the remote file editing system.
 *
 * Defines metadata, save results, language detection, and the SFTP adapter
 * interface used to decouple the editor layer from the concrete SFTP client.
 */

// ---------------------------------------------------------------------------
// Remote file metadata
// ---------------------------------------------------------------------------

/** Metadata about a remote file, typically obtained from stat() on the server. */
export interface RemoteFileMetadata {
  /** Absolute path on the remote server. */
  path: string;

  /** File size in bytes. */
  size: number;

  /** Last-modified timestamp (epoch ms). */
  modifiedAt: number;

  /** Unix permission string (e.g. "0644"), if available. */
  permissions?: string;

  /** Whether the file is read-only (no write permission). */
  isReadOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Save result
// ---------------------------------------------------------------------------

/** Result of attempting to save a remote document. */
export interface RemoteDocumentSaveResult {
  /** Whether the save succeeded. */
  success: boolean;

  /** Error message if success is false. */
  error?: string;

  /** Timestamp (epoch ms) when the save completed. */
  savedAt: number;

  /** File size on the server after the save, if known. */
  newSize?: number;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/** Output of language detection for a remote file. */
export interface LanguageDetection {
  /** Monaco language ID (e.g. "typescript", "python"). */
  languageId: string;

  /** Common file extensions for the detected language. */
  extensions?: string[];

  /** Confidence score from 0 (guess) to 1 (certain). */
  confidence: number;
}

// ---------------------------------------------------------------------------
// SFTP adapter
// ---------------------------------------------------------------------------

/**
 * Minimal interface for SFTP operations needed by the save manager.
 *
 * Decouples the editor layer from the concrete SftpClient implementation.
 * The real adapter will be wired to the SftpClient from Issue #12.
 */
export interface SftpAdapter {
  /** Write data to a remote file, creating or overwriting it. */
  writeFile(path: string, data: Buffer | string): Promise<void>;

  /** Stat a remote file, returning modification time and size. */
  stat(path: string): Promise<{ modifiedAt: number; size: number }>;

  /** Read a remote file's text content. */
  readFileText(path: string): Promise<string>;
}
