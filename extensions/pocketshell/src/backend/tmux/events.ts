/**
 * tmux -CC Control Mode Event Types
 *
 * Ported from PocketShell Android: ControlEvent.kt
 * Reference: docs/tmux-protocol-reference.md section 2
 *
 * Discriminated union types with a `type` field for exhaustive matching.
 */

// ---------------------------------------------------------------------------
// Notification events (asynchronous, pushed by tmux)
// ---------------------------------------------------------------------------

/** %output — pane output with raw byte data */
export interface OutputEvent {
  type: 'output';
  paneId: string;   // e.g. "%0"
  data: Uint8Array;  // decoded raw bytes
}

/** %session-changed — active session changed */
export interface SessionChangedEvent {
  type: 'session-changed';
  sessionId: string;  // e.g. "$0"
  name: string;       // session name (may contain spaces)
}

/** %sessions-changed — global session list changed */
export interface SessionsChangedEvent {
  type: 'sessions-changed';
}

/** %window-add — new window created */
export interface WindowAddEvent {
  type: 'window-add';
  sessionId: string;  // not provided by tmux, filled by consumer
  windowId: string;   // e.g. "@3"
  name: string;       // not provided by tmux, filled by consumer
}

/** %window-close — window closed */
export interface WindowCloseEvent {
  type: 'window-close';
  sessionId: string;  // not provided by tmux, filled by consumer
  windowId: string;   // e.g. "@3"
}

/** %window-renamed — window renamed */
export interface WindowRenamedEvent {
  type: 'window-renamed';
  sessionId: string;  // not provided by tmux, filled by consumer
  windowId: string;   // e.g. "@3"
  name: string;
}

/** %layout-change — pane layout updated */
export interface LayoutChangeEvent {
  type: 'layout-change';
  sessionId: string;  // not provided by tmux, filled by consumer
  windowId: string;   // e.g. "@0"
  layout: string;     // layout string, e.g. "b25d,80x24,0,0,0"
}

/** %pane-mode-changed — pane entered/left special mode */
export interface PaneModeChangedEvent {
  type: 'pane-mode-changed';
  paneId: string;  // e.g. "%12"
}

// ---------------------------------------------------------------------------
// Response block markers (correlated by command number)
// ---------------------------------------------------------------------------

/** %begin — command response block start */
export interface BeginEvent {
  type: 'begin';
  time: number;     // Unix timestamp (seconds)
  number: number;   // command number
  flags: number;
}

/** %end — command response block end (success) */
export interface EndEvent {
  type: 'end';
  time: number;
  number: number;
  flags: number;
}

/** %error — command response block end (error) */
export interface ErrorEvent {
  type: 'error';
  time: number;
  number: number;
  flags: number;
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

/** %client-detached — client detached */
export interface ClientDetachedEvent {
  type: 'client-detached';
}

/** %exit — server shutting down */
export interface ExitEvent {
  type: 'exit';
  reason: string | null;  // optional human-readable text
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/**
 * All possible control-mode events from tmux -CC.
 *
 * Lines between %begin and %end/%error are NOT emitted as events;
 * they are collected as command response payload lines.
 */
export type ControlEvent =
  | OutputEvent
  | SessionChangedEvent
  | SessionsChangedEvent
  | WindowAddEvent
  | WindowCloseEvent
  | WindowRenamedEvent
  | LayoutChangeEvent
  | PaneModeChangedEvent
  | BeginEvent
  | EndEvent
  | ErrorEvent
  | ClientDetachedEvent
  | ExitEvent;

// ---------------------------------------------------------------------------
// Command response
// ---------------------------------------------------------------------------

/**
 * Result of a command sent to tmux -CC.
 * Correlates a %begin/%end (or %error) block with the queued command.
 */
export interface CommandResponse {
  /** tmux-assigned command number from %begin */
  number: number;
  /** payload lines between %begin and %end/%error */
  output: string[];
  /** true if closed by %error rather than %end */
  isError: boolean;
}

/**
 * Capture-pane result bundled with cursor position.
 */
export interface CaptureWithCursor {
  capture: CommandResponse;
  cursorReply: string | null;  // "cursor_x,cursor_y" or null
}
