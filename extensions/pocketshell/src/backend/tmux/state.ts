/**
 * tmux State Model
 *
 * Ported from PocketShell Android state model.
 * Reference: docs/tmux-protocol-reference.md section 5
 */

// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------

/** A tmux pane (terminal surface) */
export interface TmuxPane {
  /** Pane ID, e.g. "%12" */
  id: string;
  /** Parent session ID, e.g. "$0" */
  sessionId: string;
  /** Parent window ID, e.g. "@3" */
  windowId: string;
  /** Pane width in cells */
  width: number;
  /** Pane height in cells */
  height: number;
  /** Pane title */
  title: string;
  /** Pane mode: "normal" | "copy-mode" | etc. */
  mode: string;
}

/** A tmux window (tab) */
export interface TmuxWindow {
  /** Window ID, e.g. "@3" */
  id: string;
  /** Parent session ID, e.g. "$0" */
  sessionId: string;
  /** Window name */
  name: string;
  /** Whether this is the active window in its session */
  active: boolean;
  /** Layout string */
  layout: string;
  /** Panes in this window, keyed by pane ID */
  panes: Map<string, TmuxPane>;
  /** Ordered pane IDs */
  paneOrder: string[];
}

/** A tmux session */
export interface TmuxSession {
  /** Session ID, e.g. "$0" */
  id: string;
  /** Session name */
  name: string;
  /** Windows in this session, keyed by window ID */
  windows: Map<string, TmuxWindow>;
  /** Ordered window IDs */
  windowOrder: string[];
}

// ---------------------------------------------------------------------------
// Aggregate state
// ---------------------------------------------------------------------------

/** Complete tmux state snapshot */
export interface TmuxState {
  /** All sessions, keyed by session ID */
  sessions: Map<string, TmuxSession>;
  /** Active session ID */
  activeSessionId: string | null;
  /** Active window ID */
  activeWindowId: string | null;
  /** Active pane ID */
  activePaneId: string | null;
}

// ---------------------------------------------------------------------------
// State update functions
// ---------------------------------------------------------------------------

import type { ControlEvent } from './events';

/**
 * Create an empty initial state.
 */
export function emptyState(): TmuxState {
  return {
    sessions: new Map(),
    activeSessionId: null,
    activeWindowId: null,
    activePaneId: null,
  };
}

/**
 * Apply a control event to the state, returning a new state object.
 * Pure function — does not mutate the input state.
 */
export function applyEvent(state: TmuxState, event: ControlEvent): TmuxState {
  switch (event.type) {
    case 'session-changed': {
      const sessions = new Map(state.sessions);
      // Ensure the session exists
      if (!sessions.has(event.sessionId)) {
        sessions.set(event.sessionId, {
          id: event.sessionId,
          name: event.name,
          windows: new Map(),
          windowOrder: [],
        });
      } else {
        const existing = sessions.get(event.sessionId)!;
        sessions.set(event.sessionId, { ...existing, name: event.name });
      }
      return {
        ...state,
        sessions,
        activeSessionId: event.sessionId,
      };
    }

    case 'window-add': {
      const sid = event.sessionId || state.activeSessionId;
      if (!sid) return state;
      const sessions = new Map(state.sessions);
      const session = sessions.get(sid);
      if (!session) return state;

      const windows = new Map(session.windows);
      if (!windows.has(event.windowId)) {
        windows.set(event.windowId, {
          id: event.windowId,
          sessionId: sid,
          name: event.name,
          active: false,
          layout: '',
          panes: new Map(),
          paneOrder: [],
        });
      }
      const windowOrder = [...session.windowOrder];
      if (!windowOrder.includes(event.windowId)) {
        windowOrder.push(event.windowId);
      }

      sessions.set(sid, {
        ...session,
        windows,
        windowOrder,
      });
      return { ...state, sessions };
    }

    case 'window-close': {
      const sid = event.sessionId || state.activeSessionId;
      if (!sid) return state;
      const sessions = new Map(state.sessions);
      const session = sessions.get(sid);
      if (!session) return state;

      const windows = new Map(session.windows);
      windows.delete(event.windowId);
      const windowOrder = session.windowOrder.filter(id => id !== event.windowId);

      sessions.set(sid, { ...session, windows, windowOrder });
      return {
        ...state,
        sessions,
        activeWindowId: state.activeWindowId === event.windowId ? null : state.activeWindowId,
      };
    }

    case 'window-renamed': {
      const sid = event.sessionId || state.activeSessionId;
      if (!sid) return state;
      const sessions = new Map(state.sessions);
      const session = sessions.get(sid);
      if (!session) return state;

      const win = session.windows.get(event.windowId);
      if (!win) return state;

      const windows = new Map(session.windows);
      windows.set(event.windowId, { ...win, name: event.name });

      sessions.set(sid, { ...session, windows });
      return { ...state, sessions };
    }

    case 'layout-change': {
      const sid = event.sessionId || state.activeSessionId;
      if (!sid) return state;
      const sessions = new Map(state.sessions);
      const session = sessions.get(sid);
      if (!session) return state;

      const win = session.windows.get(event.windowId);
      if (!win) return state;

      const windows = new Map(session.windows);
      windows.set(event.windowId, { ...win, layout: event.layout });

      sessions.set(sid, { ...session, windows });
      return { ...state, sessions };
    }

    case 'pane-mode-changed': {
      // We know the pane ID but not which window/session it belongs to.
      // Search for it across all windows.
      const sessions = new Map(state.sessions);
      for (const [sessionId, session] of sessions) {
        const windows = new Map(session.windows);
        let found = false;
        for (const [windowId, win] of windows) {
          const pane = win.panes.get(event.paneId);
          if (pane) {
            const panes = new Map(win.panes);
            panes.set(event.paneId, { ...pane, mode: 'unknown-changed' });
            windows.set(windowId, { ...win, panes });
            found = true;
            break;
          }
        }
        if (found) {
          sessions.set(sessionId, { ...session, windows });
          break;
        }
      }
      return { ...state, sessions };
    }

    case 'sessions-changed':
    case 'output':
    case 'begin':
    case 'end':
    case 'error':
    case 'client-detached':
    case 'exit':
      // These events don't directly modify the structural state
      return state;
  }
}

/**
 * Set or update a pane in the state.
 */
export function upsertPane(
  state: TmuxState,
  pane: TmuxPane,
): TmuxState {
  const sessions = new Map(state.sessions);
  const session = sessions.get(pane.sessionId);
  if (!session) return state;

  const win = session.windows.get(pane.windowId);
  if (!win) return state;

  const windows = new Map(session.windows);
  const panes = new Map(win.panes);
  const isNew = !panes.has(pane.id);
  panes.set(pane.id, pane);

  const paneOrder = isNew
    ? [...win.paneOrder, pane.id]
    : win.paneOrder;

  windows.set(pane.windowId, { ...win, panes, paneOrder });
  sessions.set(pane.sessionId, { ...session, windows });
  return { ...state, sessions };
}

/**
 * Remove a pane from the state.
 */
export function removePane(
  state: TmuxState,
  sessionId: string,
  windowId: string,
  paneId: string,
): TmuxState {
  const sessions = new Map(state.sessions);
  const session = sessions.get(sessionId);
  if (!session) return state;

  const win = session.windows.get(windowId);
  if (!win) return state;

  const windows = new Map(session.windows);
  const panes = new Map(win.panes);
  panes.delete(paneId);
  const paneOrder = win.paneOrder.filter(id => id !== paneId);

  windows.set(windowId, { ...win, panes, paneOrder });
  sessions.set(sessionId, { ...session, windows });
  return {
    ...state,
    sessions,
    activePaneId: state.activePaneId === paneId ? null : state.activePaneId,
  };
}

/**
 * Set the active window within a session.
 */
export function setActiveWindow(
  state: TmuxState,
  sessionId: string,
  windowId: string,
): TmuxState {
  const sessions = new Map(state.sessions);
  const session = sessions.get(sessionId);
  if (!session) return state;

  const windows = new Map(session.windows);
  for (const [id, win] of windows) {
    windows.set(id, { ...win, active: id === windowId });
  }

  sessions.set(sessionId, { ...session, windows });
  return {
    ...state,
    sessions,
    activeWindowId: windowId,
  };
}

/**
 * Get all panes across all sessions/windows.
 */
export function allPanes(state: TmuxState): TmuxPane[] {
  const result: TmuxPane[] = [];
  for (const session of state.sessions.values()) {
    for (const window of session.windows.values()) {
      for (const pane of window.panes.values()) {
        result.push(pane);
      }
    }
  }
  return result;
}
