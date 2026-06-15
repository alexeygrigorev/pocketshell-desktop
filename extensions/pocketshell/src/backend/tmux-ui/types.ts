/**
 * Tmux UI Types
 *
 * Extended data structures for the tmux management UI layer.
 * Enriches the flat TmuxState with terminal references and
 * hierarchical tree structure for easy UI rendering.
 */

// ---------------------------------------------------------------------------
// Split direction
// ---------------------------------------------------------------------------

/** Direction for splitting a pane. */
export type SplitDirection = 'horizontal' | 'vertical';

// ---------------------------------------------------------------------------
// Extended info types (enrich base tmux entities with terminal references)
// ---------------------------------------------------------------------------

/** Pane info enriched with terminal reference for UI rendering. */
export interface TmuxPaneInfo {
  /** Pane ID, e.g. "%12" */
  id: string;
  /** Parent window ID */
  windowId: string;
  /** Parent session ID */
  sessionId: string;
  /** Pane width in cells */
  width: number;
  /** Pane height in cells */
  height: number;
  /** Pane title */
  title: string;
  /** Pane mode */
  mode: string;
  /** Current working directory reported by tmux, when available. */
  cwd: string | undefined;
  /** Whether this pane has an active terminal attached */
  hasTerminal: boolean;
  /** Terminal ID if a terminal is attached, undefined otherwise */
  terminalId: string | undefined;
  /** Whether this is the active pane */
  isActive: boolean;
}

/** Window info with ordered pane list for UI rendering. */
export interface TmuxWindowInfo {
  /** Window ID, e.g. "@3" */
  id: string;
  /** Parent session ID */
  sessionId: string;
  /** Window name */
  name: string;
  /** Whether this is the active window */
  isActive: boolean;
  /** Layout string */
  layout: string;
  /** Ordered list of pane info objects */
  panes: TmuxPaneInfo[];
}

/** Session info with ordered window list for UI rendering. */
export interface TmuxSessionInfo {
  /** Session ID, e.g. "$0" */
  id: string;
  /** Session name */
  name: string;
  /** Whether this is the active session */
  isActive: boolean;
  /** Ordered list of window info objects */
  windows: TmuxWindowInfo[];
}

// ---------------------------------------------------------------------------
// Full tree snapshot
// ---------------------------------------------------------------------------

/**
 * Complete hierarchical snapshot of tmux state for UI rendering.
 *
 * Built from the flat TmuxState + pane-to-terminal mapping.
 * Pure value object — no side effects.
 */
export interface TmuxTreeSnapshot {
  /** All sessions, ordered by ID */
  sessions: TmuxSessionInfo[];
  /** Active session ID (null if no active session) */
  activeSessionId: string | null;
  /** Active window ID */
  activeWindowId: string | null;
  /** Active pane ID */
  activePaneId: string | null;
}
