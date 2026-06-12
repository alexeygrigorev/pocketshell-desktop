/**
 * StatusDot utility for rendering connection-state indicators.
 *
 * Maps connection states to hex colors, CSS class names, and HTML
 * snippets. Pure functions with no DOM dependency — the HTML strings
 * are consumed by whatever rendering layer is active.
 */

import {
  STATUS_DOT_COLORS,
  type ConnectionState,
} from './pocketshell-dark';

// ---------------------------------------------------------------------------
// CSS class name mapping
// ---------------------------------------------------------------------------

/** Maps a connection state to a CSS class name for the status dot. */
const STATUS_DOT_CLASSES: Record<ConnectionState, string> = {
  connected: 'status-connected',
  disconnected: 'status-disconnected',
  connecting: 'status-connecting-pulse',
  error: 'status-error',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the hex color for a connection state dot.
 *
 * @param state - Connection state identifier.
 * @returns Hex color string (e.g. `'#00e676'`).
 */
export function getDotColor(state: ConnectionState): string {
  return STATUS_DOT_COLORS[state];
}

/**
 * Returns the CSS class name for a connection state dot.
 *
 * Connecting dots get the `-pulse` suffix so the CSS animation can
 * apply a breathing effect.
 *
 * @param state - Connection state identifier.
 * @returns CSS class name (e.g. `'status-connected'`).
 */
export function getDotClass(state: ConnectionState): string {
  return STATUS_DOT_CLASSES[state];
}

/**
 * Renders an HTML snippet for a status dot.
 *
 * The returned `<span>` has the state class and an inline background
 * color so it works even before a stylesheet is loaded.
 *
 * @param state - Connection state identifier.
 * @returns HTML string for the dot element.
 */
export function renderDot(state: ConnectionState): string {
  const color = getDotColor(state);
  const cls = getDotClass(state);
  return `<span class="status-dot ${cls}" style="background:${color}"></span>`;
}
