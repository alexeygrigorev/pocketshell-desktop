/**
 * Snapshot Builder
 *
 * Converts the flat TmuxState + pane-to-terminal mapping into a hierarchical
 * TmuxTreeSnapshot suitable for UI rendering.
 *
 * Pure function — no side effects.
 */

import type { TmuxState } from '../tmux/state';
import type { TmuxTreeSnapshot, TmuxSessionInfo, TmuxWindowInfo, TmuxPaneInfo } from './types';

/**
 * Build a hierarchical tree snapshot from flat state.
 *
 * @param state - The current flat TmuxState from TmuxClient
 * @param paneTerminalMap - Map from pane ID to terminal ID
 * @returns A TmuxTreeSnapshot ready for UI rendering
 */
export function buildSnapshot(
  state: TmuxState,
  paneTerminalMap: ReadonlyMap<string, string>,
): TmuxTreeSnapshot {
  const sessions: TmuxSessionInfo[] = [];

  for (const [sessionId, session] of state.sessions) {
    const windows: TmuxWindowInfo[] = [];

    for (const windowId of session.windowOrder) {
      const window = session.windows.get(windowId);
      if (!window) continue;

      const panes: TmuxPaneInfo[] = [];

      for (const paneId of window.paneOrder) {
        const pane = window.panes.get(paneId);
        if (!pane) continue;

        const terminalId = paneTerminalMap.get(paneId);

        panes.push({
          id: pane.id,
          windowId: pane.windowId,
          sessionId: pane.sessionId,
          width: pane.width,
          height: pane.height,
          title: pane.title,
          mode: pane.mode,
          cwd: pane.cwd,
          hasTerminal: terminalId !== undefined,
          terminalId,
          isActive: state.activePaneId === paneId,
        });
      }

      windows.push({
        id: window.id,
        sessionId: window.sessionId,
        name: window.name,
        isActive: window.active || state.activeWindowId === windowId,
        layout: window.layout,
        panes,
      });
    }

    sessions.push({
      id: session.id,
      name: session.name,
      isActive: state.activeSessionId === sessionId,
      windows,
    });
  }

  return {
    sessions,
    activeSessionId: state.activeSessionId,
    activeWindowId: state.activeWindowId,
    activePaneId: state.activePaneId,
  };
}
