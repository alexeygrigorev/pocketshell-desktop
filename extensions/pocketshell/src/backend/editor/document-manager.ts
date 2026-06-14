/**
 * Document manager for the remote file editing system.
 *
 * Manages all open remote documents — opening, retrieving, closing,
 * and tracking dirty state. Emits events for lifecycle changes.
 */

import { RemoteDocument } from './remote-document';
import type { Event } from './remote-document';
import type { RemoteFileMetadata } from './types';

// ---------------------------------------------------------------------------
// Lightweight event emitter (shared pattern, no external deps)
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
// DocumentManager
// ---------------------------------------------------------------------------

export class DocumentManager {
  private documents = new Map<string, RemoteDocument>();

  // --- Events --------------------------------------------------------------

  private readonly openEventEmitter = new SimpleEvent<RemoteDocument>();
  private readonly closeEventEmitter = new SimpleEvent<string>();
  private readonly dirtyChangeEventEmitter = new SimpleEvent<{ path: string; isDirty: boolean }>();

  /** Fires when a document is opened. */
  public readonly onDidOpen: Event<RemoteDocument>;

  /** Fires when a document is closed, with its remote path. */
  public readonly onDidClose: Event<string>;

  /** Fires when a document's dirty state changes. */
  public readonly onDidChangeDirty: Event<{ path: string; isDirty: boolean }>;

  // --- Cleanup tracking for per-document listeners -------------------------

  /** Unsubscribe functions for dirty-change listeners per document path. */
  private dirtyUnsubs = new Map<string, () => void>();

  // --- Constructor ---------------------------------------------------------

  constructor() {
    this.onDidOpen = this.openEventEmitter;
    this.onDidClose = this.closeEventEmitter;
    this.onDidChangeDirty = this.dirtyChangeEventEmitter;
  }

  // --- Public API ----------------------------------------------------------

  /**
   * Open a new remote document.
   *
   * @throws Error if a document is already open at the given path.
   */
  openDocument(path: string, content: string, metadata: RemoteFileMetadata): RemoteDocument {
    const normalizedPath = normalizePath(path);

    if (this.documents.has(normalizedPath)) {
      throw new Error(`Document already open: ${normalizedPath}`);
    }

    const doc = new RemoteDocument(normalizedPath, content, metadata);
    this.documents.set(normalizedPath, doc);

    // Forward dirty state changes from the document
    const unsub = doc.onDidChangeDirty.listen((isDirty) => {
      this.dirtyChangeEventEmitter.emit({ path: normalizedPath, isDirty });
    });
    this.dirtyUnsubs.set(normalizedPath, unsub);

    this.openEventEmitter.emit(doc);

    return doc;
  }

  /**
   * Get an open document by its remote path.
   *
   * Returns undefined if no document is open at that path.
   */
  getDocument(path: string): RemoteDocument | undefined {
    return this.documents.get(normalizePath(path));
  }

  /**
   * Close a document by its remote path.
   *
   * No-op if no document is open at that path.
   */
  closeDocument(path: string): void {
    const normalizedPath = normalizePath(path);
    const doc = this.documents.get(normalizedPath);
    if (!doc) return;

    // Clean up the dirty-change listener
    const unsub = this.dirtyUnsubs.get(normalizedPath);
    if (unsub) {
      unsub();
      this.dirtyUnsubs.delete(normalizedPath);
    }

    this.documents.delete(normalizedPath);
    this.closeEventEmitter.emit(normalizedPath);
  }

  /**
   * List all currently open documents.
   */
  listOpenDocuments(): RemoteDocument[] {
    return Array.from(this.documents.values());
  }

  /**
   * List all documents with unsaved changes.
   */
  getDirtyDocuments(): RemoteDocument[] {
    return this.listOpenDocuments().filter((doc) => doc.isDirty);
  }

  /**
   * Close all open documents.
   */
  closeAll(): void {
    // Collect paths first to avoid mutating during iteration
    const paths = Array.from(this.documents.keys());
    for (const p of paths) {
      this.closeDocument(p);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a remote file path for consistent map lookups. */
function normalizePath(path: string): string {
  // Collapse duplicate slashes, remove trailing slash (unless root)
  let normalized = path.replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
