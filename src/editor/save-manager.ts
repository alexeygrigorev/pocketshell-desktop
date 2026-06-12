/**
 * Remote save manager.
 *
 * Handles saving remote documents back to the server via the SftpAdapter
 * interface. Includes conflict detection (remote file modified since load)
 * and batch save support.
 */

import { RemoteDocument } from './remote-document';
import type { Event } from './remote-document';
import type { RemoteDocumentSaveResult, SftpAdapter } from './types';

// ---------------------------------------------------------------------------
// Lightweight event emitter (shared pattern)
// ---------------------------------------------------------------------------

type Listener<T> = (data: T) => void;

class SimpleEvent<T> {
  private listeners: Listener<T>[] = [];

  listen(fn: Listener<T>): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  emit(data: T): void {
    for (const fn of this.listeners) {
      try {
        fn(data);
      } catch {
        // Swallow listener errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RemoteSaveManager
// ---------------------------------------------------------------------------

export class RemoteSaveManager {
  private sftp: SftpAdapter;

  // --- Events --------------------------------------------------------------

  private readonly saveEventEmitter = new SimpleEvent<string>();

  /** Fires with the remote path when a save succeeds. */
  public readonly onDidSave: Event<string>;

  // --- Constructor ---------------------------------------------------------

  constructor(sftpAdapter: SftpAdapter) {
    this.sftp = sftpAdapter;
    this.onDidSave = this.saveEventEmitter;
  }

  // --- Public API ----------------------------------------------------------

  /**
   * Save a single remote document.
   *
   * Steps:
   * 1. Read-only check
   * 2. Conflict detection — compare remote mtime with document metadata
   * 3. Write the file via SFTP
   * 4. Mark the document as saved
   *
   * @returns Save result indicating success or failure
   */
  async save(document: RemoteDocument): Promise<RemoteDocumentSaveResult> {
    // Read-only guard
    if (document.metadata.isReadOnly) {
      return fail('File is read-only');
    }

    try {
      // Conflict detection: check if the remote file was modified since we loaded it
      const remoteStat = await this.sftp.stat(document.path);
      if (remoteStat.modifiedAt !== document.metadata.modifiedAt) {
        return fail(
          `Conflict: remote file was modified at ${new Date(remoteStat.modifiedAt).toISOString()}, ` +
          `expected ${new Date(document.metadata.modifiedAt).toISOString()}`,
        );
      }

      // Write the content
      await this.sftp.writeFile(document.path, document.content);

      // Verify the write and get new metadata
      let newSize: number | undefined;
      try {
        const postStat = await this.sftp.stat(document.path);
        newSize = postStat.size;
      } catch {
        // Stat after write is best-effort
      }

      // Mark the document as saved
      document.markSaved();

      this.saveEventEmitter.emit(document.path);

      return {
        success: true,
        savedAt: Date.now(),
        newSize,
      };
    } catch (err: any) {
      return fail(err.message ?? String(err));
    }
  }

  /**
   * Save a document to a new remote path (Save As).
   *
   * Writes to the new path and marks the document as saved.
   * Does NOT update the document's path — the caller can do that
   * if desired (e.g. by creating a new document at the new path).
   *
   * @param document  The document to save
   * @param newPath   The remote path to save to
   */
  async saveAs(document: RemoteDocument, newPath: string): Promise<RemoteDocumentSaveResult> {
    try {
      await this.sftp.writeFile(newPath, document.content);

      let newSize: number | undefined;
      try {
        const postStat = await this.sftp.stat(newPath);
        newSize = postStat.size;
      } catch {
        // Best-effort
      }

      document.markSaved();

      this.saveEventEmitter.emit(newPath);

      return {
        success: true,
        savedAt: Date.now(),
        newSize,
      };
    } catch (err: any) {
      return fail(err.message ?? String(err));
    }
  }

  /**
   * Save multiple documents in parallel.
   *
   * @returns A map from document path to save result
   */
  async saveAll(documents: RemoteDocument[]): Promise<Map<string, RemoteDocumentSaveResult>> {
    const results = new Map<string, RemoteDocumentSaveResult>();

    // Save all in parallel — each save is independent
    const promises = documents.map(async (doc) => {
      const result = await this.save(doc);
      results.set(doc.path, result);
    });

    await Promise.all(promises);
    return results;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(error: string): RemoteDocumentSaveResult {
  return { success: false, error, savedAt: Date.now() };
}
