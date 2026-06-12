/**
 * Snapshot Builder unit tests
 *
 * Tests the buildSnapshot() pure function that converts flat TmuxState
 * into a hierarchical TmuxTreeSnapshot for UI rendering.
 */

import { describe, it, expect } from 'vitest';
import { buildSnapshot } from '../../../src/tmux-ui/snapshot-builder';
import type { TmuxTreeSnapshot, TmuxSessionInfo, TmuxWindowInfo, TmuxPaneInfo } from '../../../src/tmux-ui/types';
import { emptyState, applyEvent, upsertPane } from '../../../src/tmux/state';
import type { TmuxState, TmuxPane } from '../../../src/tmux/state';

// ---------------------------------------------------------------------------
// Helpers to build test state
// ---------------------------------------------------------------------------

function buildTestState(): TmuxState {
  let state = emptyState();

  // Session 1
  state = applyEvent(state, {
    type: 'session-changed',
    sessionId: '$0',
    name: 'main',
  });

  state = applyEvent(state, {
    type: 'window-add',
    sessionId: '$0',
    windowId: '@0',
    name: 'editor',
  });

  state = applyEvent(state, {
    type: 'window-add',
    sessionId: '$0',
    windowId: '@1',
    name: 'build',
  });

  state = applyEvent(state, {
    type: 'layout-change',
    sessionId: '$0',
    windowId: '@0',
    layout: 'b25d,80x24,0,0{0}',
  });

  // Session 2
  state = applyEvent(state, {
    type: 'session-changed',
    sessionId: '$1',
    name: 'aux',
  });

  state = applyEvent(state, {
    type: 'window-add',
    sessionId: '$1',
    windowId: '@2',
    name: 'logs',
  });

  // Add panes
  state = upsertPane(state, {
    id: '%0', sessionId: '$0', windowId: '@0',
    width: 80, height: 24, title: 'bash', mode: 'normal',
  });

  state = upsertPane(state, {
    id: '%1', sessionId: '$0', windowId: '@0',
    width: 40, height: 24, title: 'vim', mode: 'normal',
  });

  state = upsertPane(state, {
    id: '%2', sessionId: '$0', windowId: '@1',
    width: 80, height: 24, title: 'make', mode: 'normal',
  });

  state = upsertPane(state, {
    id: '%3', sessionId: '$1', windowId: '@2',
    width: 120, height: 40, title: 'tail', mode: 'normal',
  });

  // Set active markers
  state = { ...state, activeSessionId: '$0', activeWindowId: '@0', activePaneId: '%0' };

  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSnapshot', () => {
  describe('empty state', () => {
    it('returns empty snapshot for empty state', () => {
      const snapshot = buildSnapshot(emptyState(), new Map());

      expect(snapshot.sessions).toEqual([]);
      expect(snapshot.activeSessionId).toBeNull();
      expect(snapshot.activeWindowId).toBeNull();
      expect(snapshot.activePaneId).toBeNull();
    });

    it('returns empty snapshot with no terminals', () => {
      let state = applyEvent(emptyState(), {
        type: 'session-changed', sessionId: '$0', name: 's',
      });

      const snapshot = buildSnapshot(state, new Map());
      expect(snapshot.sessions).toHaveLength(1);
      expect(snapshot.sessions[0].windows).toHaveLength(0);
    });
  });

  describe('tree structure', () => {
    it('builds sessions -> windows -> panes tree', () => {
      const state = buildTestState();
      const paneTerminalMap = new Map<string, string>();

      const snapshot = buildSnapshot(state, paneTerminalMap);

      // 2 sessions
      expect(snapshot.sessions).toHaveLength(2);

      // Session $0: "main" — 2 windows
      const mainSession = snapshot.sessions[0];
      expect(mainSession.id).toBe('$0');
      expect(mainSession.name).toBe('main');
      expect(mainSession.windows).toHaveLength(2);

      // Window @0: "editor" — 2 panes
      const editorWindow = mainSession.windows[0];
      expect(editorWindow.id).toBe('@0');
      expect(editorWindow.name).toBe('editor');
      expect(editorWindow.panes).toHaveLength(2);
      expect(editorWindow.panes[0].id).toBe('%0');
      expect(editorWindow.panes[1].id).toBe('%1');

      // Window @1: "build" — 1 pane
      const buildWindow = mainSession.windows[1];
      expect(buildWindow.id).toBe('@1');
      expect(buildWindow.name).toBe('build');
      expect(buildWindow.panes).toHaveLength(1);
      expect(buildWindow.panes[0].id).toBe('%2');

      // Session $1: "aux" — 1 window
      const auxSession = snapshot.sessions[1];
      expect(auxSession.id).toBe('$1');
      expect(auxSession.name).toBe('aux');
      expect(auxSession.windows).toHaveLength(1);

      const logsWindow = auxSession.windows[0];
      expect(logsWindow.id).toBe('@2');
      expect(logsWindow.name).toBe('logs');
      expect(logsWindow.panes).toHaveLength(1);
      expect(logsWindow.panes[0].id).toBe('%3');
    });

    it('preserves pane order from state', () => {
      const state = buildTestState();
      const snapshot = buildSnapshot(state, new Map());

      const editorPanes = snapshot.sessions[0].windows[0].panes;
      expect(editorPanes.map(p => p.id)).toEqual(['%0', '%1']);
    });

    it('preserves window order from state', () => {
      const state = buildTestState();
      const snapshot = buildSnapshot(state, new Map());

      const mainWindows = snapshot.sessions[0].windows;
      expect(mainWindows.map(w => w.id)).toEqual(['@0', '@1']);
    });
  });

  describe('active markers', () => {
    it('marks active session', () => {
      const state = buildTestState();
      const snapshot = buildSnapshot(state, new Map());

      expect(snapshot.activeSessionId).toBe('$0');
      expect(snapshot.sessions[0].isActive).toBe(true);
      expect(snapshot.sessions[1].isActive).toBe(false);
    });

    it('marks active window', () => {
      const state = buildTestState();
      const snapshot = buildSnapshot(state, new Map());

      expect(snapshot.activeWindowId).toBe('@0');

      const mainSession = snapshot.sessions[0];
      expect(mainSession.windows[0].isActive).toBe(true); // @0
      expect(mainSession.windows[1].isActive).toBe(false); // @1
    });

    it('marks active pane', () => {
      const state = buildTestState();
      const snapshot = buildSnapshot(state, new Map());

      expect(snapshot.activePaneId).toBe('%0');

      const editorPanes = snapshot.sessions[0].windows[0].panes;
      expect(editorPanes[0].isActive).toBe(true);  // %0
      expect(editorPanes[1].isActive).toBe(false);  // %1
    });

    it('no active markers when null', () => {
      let state = buildTestState();
      state = { ...state, activeSessionId: null, activeWindowId: null, activePaneId: null };

      const snapshot = buildSnapshot(state, new Map());

      expect(snapshot.activeSessionId).toBeNull();
      expect(snapshot.activeWindowId).toBeNull();
      expect(snapshot.activePaneId).toBeNull();

      // Nothing marked active
      for (const session of snapshot.sessions) {
        expect(session.isActive).toBe(false);
        for (const window of session.windows) {
          expect(window.isActive).toBe(false);
          for (const pane of window.panes) {
            expect(pane.isActive).toBe(false);
          }
        }
      }
    });
  });

  describe('terminal status', () => {
    it('marks panes with terminals', () => {
      const state = buildTestState();
      const paneTerminalMap = new Map<string, string>([
        ['%0', 'ssh-term-1'],
        ['%2', 'ssh-term-2'],
      ]);

      const snapshot = buildSnapshot(state, paneTerminalMap);

      // %0 has terminal
      const pane0 = snapshot.sessions[0].windows[0].panes[0];
      expect(pane0.hasTerminal).toBe(true);
      expect(pane0.terminalId).toBe('ssh-term-1');

      // %1 has no terminal
      const pane1 = snapshot.sessions[0].windows[0].panes[1];
      expect(pane1.hasTerminal).toBe(false);
      expect(pane1.terminalId).toBeUndefined();

      // %2 has terminal
      const pane2 = snapshot.sessions[0].windows[1].panes[0];
      expect(pane2.hasTerminal).toBe(true);
      expect(pane2.terminalId).toBe('ssh-term-2');

      // %3 has no terminal
      const pane3 = snapshot.sessions[1].windows[0].panes[0];
      expect(pane3.hasTerminal).toBe(false);
      expect(pane3.terminalId).toBeUndefined();
    });

    it('all panes without terminals by default', () => {
      const state = buildTestState();
      const snapshot = buildSnapshot(state, new Map());

      for (const session of snapshot.sessions) {
        for (const window of session.windows) {
          for (const pane of window.panes) {
            expect(pane.hasTerminal).toBe(false);
            expect(pane.terminalId).toBeUndefined();
          }
        }
      }
    });

    it('all panes with terminals when mapped', () => {
      const state = buildTestState();
      const paneTerminalMap = new Map<string, string>([
        ['%0', 't1'],
        ['%1', 't2'],
        ['%2', 't3'],
        ['%3', 't4'],
      ]);

      const snapshot = buildSnapshot(state, paneTerminalMap);

      for (const session of snapshot.sessions) {
        for (const window of session.windows) {
          for (const pane of window.panes) {
            expect(pane.hasTerminal).toBe(true);
            expect(pane.terminalId).toBeDefined();
          }
        }
      }
    });
  });

  describe('pane dimensions', () => {
    it('includes width and height from state', () => {
      const state = buildTestState();
      const snapshot = buildSnapshot(state, new Map());

      const pane0 = snapshot.sessions[0].windows[0].panes[0];
      expect(pane0.width).toBe(80);
      expect(pane0.height).toBe(24);
      expect(pane0.title).toBe('bash');
      expect(pane0.mode).toBe('normal');

      const pane3 = snapshot.sessions[1].windows[0].panes[0];
      expect(pane3.width).toBe(120);
      expect(pane3.height).toBe(40);
      expect(pane3.title).toBe('tail');
    });
  });

  describe('window layout', () => {
    it('includes layout string from state', () => {
      const state = buildTestState();
      const snapshot = buildSnapshot(state, new Map());

      const editorWindow = snapshot.sessions[0].windows[0];
      expect(editorWindow.layout).toBe('b25d,80x24,0,0{0}');
    });
  });
});
