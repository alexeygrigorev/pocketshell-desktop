/**
 * Application settings store for PocketShell Desktop.
 *
 * Persists user preferences to `~/.pocketshell/settings.json`.
 * Provides load/save/update with sensible defaults.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDefaultsMap } from '../ui/settings/settings-schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppSettings {
  /** Whether to auto-connect to the last-used host on startup. */
  autoConnect: boolean;

  /** ID of the most recently connected host (used as a hint, not authoritative). */
  lastHostId: number | null;

  /** Whether to restore the last PocketShell session layout when the app starts. */
  restoreSessionOnStartup: boolean;

  /** How startup restore should handle missing or disconnected session hosts. */
  sessionRestoreBehavior: 'ask' | 'restore-ready' | 'skip';

  /** Whether selected active port forwards are restored after startup or reconnect. */
  portForwardRestoreActiveTunnels: boolean;

  /** UI color theme. */
  theme: 'dark' | 'light' | 'system';

  /** Whether local diagnostic event capture is enabled. */
  diagnosticsEnabled: boolean;

  /** Maximum number of in-memory diagnostic events to retain. */
  diagnosticsMaxEvents: number;

  /** Privacy mode for copied diagnostics reports. */
  diagnosticsRedactionMode: 'strict' | 'balanced' | 'off';
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const UI_DEFAULTS = getDefaultsMap();

export const DEFAULT_SETTINGS: AppSettings = {
  autoConnect: UI_DEFAULTS.autoConnect as boolean,
  lastHostId: UI_DEFAULTS.lastHostId as number | null,
  restoreSessionOnStartup: UI_DEFAULTS.restoreSessionOnStartup as boolean,
  sessionRestoreBehavior: UI_DEFAULTS.sessionRestoreBehavior as AppSettings['sessionRestoreBehavior'],
  portForwardRestoreActiveTunnels: UI_DEFAULTS.portForwardRestoreActiveTunnels as boolean,
  theme: UI_DEFAULTS.theme as AppSettings['theme'],
  diagnosticsEnabled: UI_DEFAULTS.diagnosticsEnabled as boolean,
  diagnosticsMaxEvents: UI_DEFAULTS.diagnosticsMaxEvents as number,
  diagnosticsRedactionMode: UI_DEFAULTS.diagnosticsRedactionMode as AppSettings['diagnosticsRedactionMode'],
};

// ---------------------------------------------------------------------------
// SettingsStore
// ---------------------------------------------------------------------------

export class SettingsStore {
  private filePath: string;
  private cache: AppSettings | null = null;

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? path.join(os.homedir(), '.pocketshell', 'settings.json');
  }

  /**
   * Load settings from disk.
   *
   * If the file does not exist or is malformed, returns defaults.
   * Results are cached for subsequent calls until `save()` or `update()`.
   */
  load(): AppSettings {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.cache = { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      this.cache = { ...DEFAULT_SETTINGS };
    }
    return this.cache!;
  }

  /**
   * Persist settings to disk.
   *
   * Creates the parent directory if it does not exist.
   */
  save(settings: AppSettings): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(settings, null, 2), 'utf-8');
    this.cache = { ...settings };
  }

  /**
   * Merge a partial update into the current settings and persist.
   *
   * Loads settings first if not already cached.
   */
  update(partial: Partial<AppSettings>): void {
    const current = this.cache ?? this.load();
    const merged = { ...current, ...partial };
    this.save(merged);
  }

  /**
   * Return the cached settings, loading from disk if needed.
   */
  get(): AppSettings {
    return this.cache ?? this.load();
  }
}
