/**
 * Remote file document model.
 *
 * Represents a single remote file open for editing. Tracks content, dirty state,
 * version, and emits events on changes. This is the document model that Monaco
 * will consume — no Monaco imports here.
 */

import type { RemoteFileMetadata } from './types';
import { detectLanguage } from './language-detection';

// ---------------------------------------------------------------------------
// Lightweight event emitter (no external deps)
// ---------------------------------------------------------------------------

type Listener<T> = (data: T) => void;

class SimpleEvent<T> {
  private listeners: Listener<T>[] = [];

  /** Subscribe to events. Returns an unsubscribe function. */
  listen(fn: Listener<T>): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Emit an event to all listeners. */
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

/** Read-only event handle exposed to consumers. */
export interface Event<T> {
  listen(fn: (data: T) => void): () => void;
}

// ---------------------------------------------------------------------------
// RemoteDocument
// ---------------------------------------------------------------------------

export class RemoteDocument {
  // --- Public read-only properties ----------------------------------------

  /** Remote file path. */
  public readonly path: string;

  /** File encoding (default 'utf-8'). */
  public readonly encoding: string;

  /** Detected Monaco language ID. */
  public readonly language: string | undefined;

  /** Metadata from the remote server at load time. */
  public readonly metadata: RemoteFileMetadata;

  // --- Mutable state -------------------------------------------------------

  /** Current content of the document. */
  private _content: string;

  /** Content at load time or last successful save. */
  private _originalContent: string;

  /** Whether the document has unsaved changes. */
  private _isDirty = false;

  /** Incrementing version counter, bumped on every content change. */
  private _version: number;

  // --- Events --------------------------------------------------------------

  private readonly contentEventEmitter = new SimpleEvent<string>();
  private readonly dirtyEventEmitter = new SimpleEvent<boolean>();

  /** Fires with the new content whenever the content changes. */
  public readonly onDidChangeContent: Event<string>;

  /** Fires with the new dirty state whenever it changes. */
  public readonly onDidChangeDirty: Event<boolean>;

  // --- Constructor ---------------------------------------------------------

  constructor(path: string, content: string, metadata: RemoteFileMetadata) {
    this.path = path;
    this._content = content;
    this._originalContent = content;
    this.metadata = metadata;
    this.encoding = 'utf-8';
    this._version = 1;

    // Wire up event handles to their emitters
    this.onDidChangeContent = this.contentEventEmitter;
    this.onDidChangeDirty = this.dirtyEventEmitter;

    // Detect language from path and optionally content
    const detection = detectLanguage(path, content);
    if (detection.confidence > 0) {
      this.language = detection.languageId;
    }
  }

  // --- Getters -------------------------------------------------------------

  /** Current document content. */
  get content(): string {
    return this._content;
  }

  /** Content at load time or last successful save. */
  get originalContent(): string {
    return this._originalContent;
  }

  /** Whether the document has unsaved changes. */
  get isDirty(): boolean {
    return this._isDirty;
  }

  /** Incrementing version counter. */
  get version(): number {
    return this._version;
  }

  // --- Mutation methods ----------------------------------------------------

  /**
   * Update the document content.
   *
   * Increments the version counter, recalculates dirty state,
   * and fires onDidChangeContent (always) and onDidChangeDirty (if dirty changed).
   */
  updateContent(newContent: string): void {
    if (newContent === this._content) {
      return; // No-op for identical content
    }

    this._content = newContent;
    this._version++;

    this.contentEventEmitter.emit(newContent);

    const newDirty = this._content !== this._originalContent;
    if (newDirty !== this._isDirty) {
      this._isDirty = newDirty;
      this.dirtyEventEmitter.emit(this._isDirty);
    }
  }

  /**
   * Mark the document as saved.
   *
   * Resets the dirty flag and updates originalContent to match current content.
   */
  markSaved(): void {
    this._originalContent = this._content;

    if (this._isDirty) {
      this._isDirty = false;
      this.dirtyEventEmitter.emit(false);
    }
  }

  /**
   * Revert the document to its original content (load time or last save).
   *
   * Resets content, increments version, and clears dirty state.
   */
  revert(): void {
    if (this._content === this._originalContent) {
      return; // Already at original
    }

    this._content = this._originalContent;
    this._version++;

    this.contentEventEmitter.emit(this._content);

    if (this._isDirty) {
      this._isDirty = false;
      this.dirtyEventEmitter.emit(false);
    }
  }
}
