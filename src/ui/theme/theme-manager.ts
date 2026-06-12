/**
 * ThemeManager — applies and queries the active PocketShell theme.
 *
 * For v0.1.0 the theme is always PocketShell Dark. The manager
 * provides a typed API for reading colors, checking dark mode, and
 * mapping connection states to status-dot colors. It emits events
 * when the theme changes (prepared for future light-mode support).
 */

import { PALETTE, STATUS_DOT_COLORS, POCKETSHELL_DARK_THEME, DENSE_LAYOUT_CSS, type ConnectionState } from './pocketshell-dark';
import { getDotColor } from './status-dots';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Color map returned by {@link ThemeManager.getColors}. */
export type ColorMap = Readonly<typeof PALETTE>;

// ---------------------------------------------------------------------------
// ThemeManager
// ---------------------------------------------------------------------------

/**
 * Manages the active UI theme.
 *
 * For v0.1.0 only PocketShell Dark exists. Call {@link apply} to
 * activate the theme; listeners registered via {@link onChange} are
 * notified (future-proofing for theme switching).
 */
export class ThemeManager {
  /** Whether the theme has been applied at least once. */
  private applied = false;

  /** Registered change listeners. */
  private listeners: Array<() => void> = [];

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Applies the PocketShell dark theme.
   *
   * Marks the theme as active and notifies change listeners. In a
   * real workbench this would push colors into VS Code's theme
   * registry; here it sets internal state for the query methods.
   */
  apply(): void {
    this.applied = true;
    this.notifyListeners();
  }

  /**
   * Returns the full color palette of the active theme.
   *
   * @returns Frozen color map.
   */
  getColors(): ColorMap {
    return PALETTE;
  }

  /**
   * Returns the hex color for a connection-state dot.
   *
   * @param state - Connection state identifier.
   * @returns Hex color string.
   */
  getStatusColor(state: ConnectionState): string {
    return getDotColor(state);
  }

  /**
   * Returns `true` — PocketShell Dark is always a dark theme.
   *
   * @returns Always `true` for v0.1.0.
   */
  isDark(): boolean {
    return true;
  }

  /**
   * Returns the VS Code color theme definition object.
   *
   * Useful for serialization or for pushing into a workbench API.
   */
  getThemeDefinition(): Readonly<typeof POCKETSHELL_DARK_THEME> {
    return POCKETSHELL_DARK_THEME;
  }

  /**
   * Returns the dense-layout CSS custom-property overrides.
   */
  getDenseLayoutCSS(): Readonly<Record<string, string>> {
    return DENSE_LAYOUT_CSS;
  }

  /**
   * Registers a listener called when the theme changes.
   *
   * @param listener - Callback invoked on theme apply/switch.
   * @returns Disposable-like unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((fn) => fn !== listener);
    };
  }

  /**
   * Returns whether the theme has been applied.
   */
  isApplied(): boolean {
    return this.applied;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Notify all registered change listeners. */
  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
