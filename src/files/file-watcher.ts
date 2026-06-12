/**
 * Remote file watcher for PocketShell Desktop.
 *
 * Since ssh2's SFTP does not support inotify/fsevents, this watcher uses
 * polling: it periodically compares directory listings and fires an event
 * when a change is detected.
 */

import type { SftpClient } from './sftp-client';
import type { RemoteFileEntry } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileWatchCallback = (path: string) => void;

// ---------------------------------------------------------------------------
// RemoteFileWatcher
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 2000;

interface WatchState {
  timer: ReturnType<typeof setInterval>;
  lastEntries: RemoteFileEntry[];
}

/**
 * Watches remote directories for changes by polling SFTP listings.
 *
 * Change detection compares file names and metadata (size, modifiedAt) between
 * polls. Fires `onChange` with the path of the changed directory.
 */
export class RemoteFileWatcher {
  private sftpClient: SftpClient;
  private pollIntervalMs: number;
  private watches = new Map<string, WatchState>();
  private callbacks: FileWatchCallback[] = [];

  constructor(sftpClient: SftpClient, options?: { interval?: number }) {
    this.sftpClient = sftpClient;
    this.pollIntervalMs = options?.interval ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Event emitted when a watched directory changes.
   * Subscribe via onChange(callback); returns an unsubscribe function.
   */
  onChange(callback: FileWatchCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx >= 0) this.callbacks.splice(idx, 1);
    };
  }

  /**
   * Start watching a directory for changes.
   */
  async watch(path: string): Promise<void> {
    if (this.watches.has(path)) {
      return; // Already watching
    }

    // Fetch initial listing
    let lastEntries: RemoteFileEntry[];
    try {
      lastEntries = await this.sftpClient.readdir(path);
    } catch {
      // If we can't read it now, start with empty and try again on next poll
      lastEntries = [];
    }

    const timer = setInterval(async () => {
      await this.poll(path);
    }, this.pollIntervalMs);

    this.watches.set(path, { timer, lastEntries });
  }

  /**
   * Stop watching a directory.
   */
  unwatch(path: string): void {
    const state = this.watches.get(path);
    if (state) {
      clearInterval(state.timer);
      this.watches.delete(path);
    }
  }

  /**
   * Stop all watches.
   */
  unwatchAll(): void {
    for (const [path] of this.watches) {
      this.unwatch(path);
    }
  }

  // -- Internal ----------------------------------------------------------------

  private async poll(path: string): Promise<void> {
    const state = this.watches.get(path);
    if (!state) return;

    let currentEntries: RemoteFileEntry[];
    try {
      currentEntries = await this.sftpClient.readdir(path);
    } catch {
      // If the read fails, skip this poll cycle
      return;
    }

    if (this.entriesDiffer(state.lastEntries, currentEntries)) {
      state.lastEntries = currentEntries;
      this.emitChange(path);
    } else {
      state.lastEntries = currentEntries;
    }
  }

  /**
   * Compare two sets of directory entries to detect changes.
   * Checks for: added/removed files, changed size, changed modification time.
   */
  private entriesDiffer(
    previous: RemoteFileEntry[],
    current: RemoteFileEntry[],
  ): boolean {
    if (previous.length !== current.length) return true;

    // Build a map of name -> entry for quick lookup
    const prevMap = new Map(previous.map((e) => [e.name, e]));

    for (const entry of current) {
      const prev = prevMap.get(entry.name);
      if (!prev) return true; // New file appeared
      if (prev.size !== entry.size) return true;
      if (prev.modifiedAt !== entry.modifiedAt) return true;
      if (prev.isDirectory !== entry.isDirectory) return true;
    }

    // Check for removed files
    const currNames = new Set(current.map((e) => e.name));
    for (const prev of previous) {
      if (!currNames.has(prev.name)) return true;
    }

    return false;
  }

  private emitChange(path: string): void {
    for (const cb of this.callbacks) {
      try {
        cb(path);
      } catch {
        // Swallow callback errors
      }
    }
  }
}
