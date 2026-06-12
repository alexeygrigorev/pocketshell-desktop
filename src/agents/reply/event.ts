/**
 * Lightweight event emitter (no external deps).
 *
 * Duplicated from editor/remote-document to keep agents module self-contained.
 */

type Listener<T> = (data: T) => void;

export class SimpleEvent<T> {
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
