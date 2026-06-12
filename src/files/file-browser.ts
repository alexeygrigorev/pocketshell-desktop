/**
 * File browser model for PocketShell Desktop.
 *
 * Provides a stateful directory navigation model backed by an SftpClient.
 * Caches listings with a configurable TTL and sorts entries (directories first,
 * then alphabetical). Supports navigation events via callback subscription.
 */

import type { SftpClient } from './sftp-client';
import type { RemoteFileEntry, FileBrowserOptions } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback fired when the browser navigates to a new directory. */
export type NavigateCallback = (path: string, entries: RemoteFileEntry[]) => void;

// ---------------------------------------------------------------------------
// FileBrowser
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL_MS = 5000;

export class FileBrowser {
  private sftpClient: SftpClient;
  private showHidden: boolean;
  private cacheTtlMs: number;

  private _currentPath = '';
  private _currentEntries: RemoteFileEntry[] = [];
  private cache = new Map<string, { entries: RemoteFileEntry[]; fetchedAt: number }>();
  private callbacks: NavigateCallback[] = [];

  constructor(sftpClient: SftpClient, options?: FileBrowserOptions & { cacheTtlMs?: number }) {
    this.sftpClient = sftpClient;
    this.showHidden = options?.showHidden ?? false;
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (options?.rootPath) {
      this._currentPath = options.rootPath;
    }
  }

  /** Current directory path. */
  get currentPath(): string {
    return this._currentPath;
  }

  /** Cached entries for the current directory. */
  get currentEntries(): RemoteFileEntry[] {
    return this._currentEntries;
  }

  // -- Navigation --------------------------------------------------------------

  /**
   * Navigate to a directory and list its contents.
   */
  async navigate(path: string): Promise<RemoteFileEntry[]> {
    const entries = await this.fetchEntries(path);
    this._currentPath = path;
    this._currentEntries = entries;
    this.emitNavigate();
    return entries;
  }

  /**
   * Navigate to the parent of the current directory.
   */
  async goUp(): Promise<RemoteFileEntry[]> {
    const parent = this.parentOf(this._currentPath);
    return this.navigate(parent);
  }

  /**
   * Reload the current directory listing.
   */
  async refresh(): Promise<RemoteFileEntry[]> {
    this.invalidateCache(this._currentPath);
    return this.navigate(this._currentPath);
  }

  /**
   * Navigate to the remote home directory.
   */
  async home(): Promise<RemoteFileEntry[]> {
    const homePath = await this.sftpClient.realpath('~');
    return this.navigate(homePath);
  }

  // -- Events ------------------------------------------------------------------

  /**
   * Subscribe to navigation events. Returns an unsubscribe function.
   */
  onNavigate(callback: NavigateCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx >= 0) this.callbacks.splice(idx, 1);
    };
  }

  // -- Internal ----------------------------------------------------------------

  /**
   * Fetch directory entries, using cache when available and not expired.
   */
  private async fetchEntries(path: string): Promise<RemoteFileEntry[]> {
    const cached = this.cache.get(path);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.entries;
    }

    let entries = await this.sftpClient.readdir(path);

    // Filter hidden files if configured
    if (!this.showHidden) {
      entries = entries.filter((e) => !e.name.startsWith('.'));
    }

    // Sort: directories first, then alphabetical by name
    entries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    this.cache.set(path, { entries, fetchedAt: Date.now() });
    return entries;
  }

  private invalidateCache(path: string): void {
    this.cache.delete(path);
  }

  private parentOf(path: string): string {
    // Normalize: remove trailing slash
    const normalized = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) return '/';
    return normalized.substring(0, lastSlash);
  }

  private emitNavigate(): void {
    for (const cb of this.callbacks) {
      try {
        cb(this._currentPath, this._currentEntries);
      } catch {
        // Swallow callback errors
      }
    }
  }
}
