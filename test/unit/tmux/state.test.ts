/**
 * State model unit tests
 *
 * Tests state updates from events.
 */

import { describe, it, expect } from 'vitest';
import {
  emptyState,
  applyEvent,
  upsertPane,
  removePane,
  setActiveWindow,
  allPanes,
} from '../../../src/tmux/state';
import type { TmuxState, TmuxPane } from '../../../src/tmux/state';
import type { ControlEvent } from '../../../src/tmux/events';

// ---------------------------------------------------------------------------
// emptyState
// ---------------------------------------------------------------------------

describe('emptyState', () => {
  it('creates an empty state', () => {
    const state = emptyState();
    expect(state.sessions.size).toBe(0);
    expect(state.activeSessionId).toBeNull();
    expect(state.activeWindowId).toBeNull();
    expect(state.activePaneId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// session-changed
// ---------------------------------------------------------------------------

describe('applyEvent — session-changed', () => {
  it('creates a new session and sets it active', () => {
    const state = applyEvent(emptyState(), {
      type: 'session-changed',
      sessionId: '$0',
      name: 'main',
    });

    expect(state.activeSessionId).toBe('$0');
    expect(state.sessions.has('$0')).toBe(true);
    expect(state.sessions.get('$0')!.name).toBe('main');
  });

  it('updates name of existing session', () => {
    let state = applyEvent(emptyState(), {
      type: 'session-changed',
      sessionId: '$0',
      name: 'old-name',
    });

    state = applyEvent(state, {
      type: 'session-changed',
      sessionId: '$0',
      name: 'new-name',
    });

    expect(state.sessions.get('$0')!.name).toBe('new-name');
  });
});

// ---------------------------------------------------------------------------
// window-add
// ---------------------------------------------------------------------------

describe('applyEvent — window-add', () => {
  it('adds a window to an existing session', () => {
    let state = applyEvent(emptyState(), {
      type: 'session-changed',
      sessionId: '$0',
      name: 'main',
    });

    state = applyEvent(state, {
      type: 'window-add',
      sessionId: '$0',
      windowId: '@0',
      name: '',
    });

    const session = state.sessions.get('$0')!;
    expect(session.windows.has('@0')).toBe(true);
    expect(session.windowOrder).toEqual(['@0']);
  });

  it('ignores window-add for unknown session', () => {
    const state = applyEvent(emptyState(), {
      type: 'window-add',
      sessionId: '$99',
      windowId: '@0',
      name: '',
    });

    expect(state.sessions.size).toBe(0);
  });

  it('does not duplicate existing window', () => {
    let state = applyEvent(emptyState(), {
      type: 'session-changed', sessionId: '$0', name: 'main',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@0', name: '',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@0', name: '',
    });

    const session = state.sessions.get('$0')!;
    expect(session.windows.size).toBe(1);
    expect(session.windowOrder).toEqual(['@0']);
  });
});

// ---------------------------------------------------------------------------
// window-close
// ---------------------------------------------------------------------------

describe('applyEvent — window-close', () => {
  it('removes a window from its session', () => {
    let state = applyEvent(emptyState(), {
      type: 'session-changed', sessionId: '$0', name: 'main',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@0', name: '',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@1', name: '',
    });

    expect(state.sessions.get('$0')!.windows.size).toBe(2);

    state = applyEvent(state, {
      type: 'window-close', sessionId: '$0', windowId: '@0',
    });

    const session = state.sessions.get('$0')!;
    expect(session.windows.has('@0')).toBe(false);
    expect(session.windows.has('@1')).toBe(true);
    expect(session.windowOrder).toEqual(['@1']);
  });

  it('clears activeWindowId when active window is closed', () => {
    let state = applyEvent(emptyState(), {
      type: 'session-changed', sessionId: '$0', name: 'main',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@0', name: '',
    });

    state = { ...state, activeWindowId: '@0' };

    state = applyEvent(state, {
      type: 'window-close', sessionId: '$0', windowId: '@0',
    });

    expect(state.activeWindowId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// window-renamed
// ---------------------------------------------------------------------------

describe('applyEvent — window-renamed', () => {
  it('renames a window', () => {
    let state = applyEvent(emptyState(), {
      type: 'session-changed', sessionId: '$0', name: 'main',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@0', name: '',
    });

    state = applyEvent(state, {
      type: 'window-renamed', sessionId: '$0', windowId: '@0', name: 'build',
    });

    expect(state.sessions.get('$0')!.windows.get('@0')!.name).toBe('build');
  });
});

// ---------------------------------------------------------------------------
// layout-change
// ---------------------------------------------------------------------------

describe('applyEvent — layout-change', () => {
  it('updates window layout', () => {
    let state = applyEvent(emptyState(), {
      type: 'session-changed', sessionId: '$0', name: 'main',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@0', name: '',
    });

    state = applyEvent(state, {
      type: 'layout-change',
      sessionId: '$0',
      windowId: '@0',
      layout: 'b25d,80x24,0,0,0',
    });

    expect(state.sessions.get('$0')!.windows.get('@0')!.layout).toBe('b25d,80x24,0,0,0');
  });
});

// ---------------------------------------------------------------------------
// Pass-through events
// ---------------------------------------------------------------------------

describe('applyEvent — pass-through events', () => {
  it('does not modify state for output events', () => {
    const initial = emptyState();
    const state = applyEvent(initial, {
      type: 'output',
      paneId: '%0',
      data: new Uint8Array([0x68, 0x69]),
    });
    expect(state).toBe(initial);
  });

  it('does not modify state for begin/end/error events', () => {
    const initial = emptyState();
    for (const type of ['begin', 'end', 'error'] as const) {
      const state = applyEvent(initial, {
        type,
        time: 1700000000,
        number: 1,
        flags: 0,
      });
      expect(state).toBe(initial);
    }
  });
});

// ---------------------------------------------------------------------------
// upsertPane
// ---------------------------------------------------------------------------

describe('upsertPane', () => {
  it('adds a new pane to a window', () => {
    let state = applyEvent(emptyState(), {
      type: 'session-changed', sessionId: '$0', name: 'main',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@0', name: '',
    });

    const pane: TmuxPane = {
      id: '%0',
      sessionId: '$0',
      windowId: '@0',
      width: 80,
      height: 24,
      title: 'bash',
      mode: 'normal',
    };

    state = upsertPane(state, pane);

    const win = state.sessions.get('$0')!.windows.get('@0')!;
    expect(win.panes.has('%0')).toBe(true);
    expect(win.panes.get('%0')!.width).toBe(80);
    expect(win.paneOrder).toEqual(['%0']);
  });

  it('updates an existing pane', () => {
    let state = applyEvent(emptyState(), {
      type: 'session-changed', sessionId: '$0', name: 'main',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@0', name: '',
    });

    state = upsertPane(state, {
      id: '%0', sessionId: '$0', windowId: '@0',
      width: 80, height: 24, title: 'bash', mode: 'normal',
    });

    state = upsertPane(state, {
      id: '%0', sessionId: '$0', windowId: '@0',
      width: 120, height: 40, title: 'vim', mode: 'normal',
    });

    const win = state.sessions.get('$0')!.windows.get('@0')!;
    expect(win.panes.get('%0')!.width).toBe(120);
    expect(win.panes.get('%0')!.title).toBe('vim');
    // Pane order should not duplicate
    expect(win.paneOrder).toEqual(['%0']);
  });
});

// ---------------------------------------------------------------------------
// removePane
// ---------------------------------------------------------------------------

describe('removePane', () => {
  it('removes a pane from its window', () => {
    let state = applyEvent(emptyState(), {
      type: 'session-changed', sessionId: '$0', name: 'main',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@0', name: '',
    });

    state = upsertPane(state, {
      id: '%0', sessionId: '$0', windowId: '@0',
      width: 80, height: 24, title: 'bash', mode: 'normal',
    });

    state = upsertPane(state, {
      id: '%1', sessionId: '$0', windowId: '@0',
      width: 40, height: 24, title: 'vim', mode: 'normal',
    });

    state = removePane(state, '$0', '@0', '%0');

    const win = state.sessions.get('$0')!.windows.get('@0')!;
    expect(win.panes.has('%0')).toBe(false);
    expect(win.panes.has('%1')).toBe(true);
    expect(win.paneOrder).toEqual(['%1']);
  });
});

// ---------------------------------------------------------------------------
// setActiveWindow
// ---------------------------------------------------------------------------

describe('setActiveWindow', () => {
  it('sets the active window in a session', () => {
    let state = applyEvent(emptyState(), {
      type: 'session-changed', sessionId: '$0', name: 'main',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@0', name: '',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@1', name: '',
    });

    state = setActiveWindow(state, '$0', '@1');

    expect(state.activeWindowId).toBe('@1');
    const session = state.sessions.get('$0')!;
    expect(session.windows.get('@0')!.active).toBe(false);
    expect(session.windows.get('@1')!.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// allPanes
// ---------------------------------------------------------------------------

describe('allPanes', () => {
  it('collects panes from all sessions and windows', () => {
    let state = applyEvent(emptyState(), {
      type: 'session-changed', sessionId: '$0', name: 'main',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@0', name: '',
    });

    state = upsertPane(state, {
      id: '%0', sessionId: '$0', windowId: '@0',
      width: 80, height: 24, title: 'bash', mode: 'normal',
    });

    state = upsertPane(state, {
      id: '%1', sessionId: '$0', windowId: '@0',
      width: 40, height: 24, title: 'vim', mode: 'normal',
    });

    const panes = allPanes(state);
    expect(panes.length).toBe(2);
    expect(panes.map(p => p.id).sort()).toEqual(['%0', '%1']);
  });
});

// ---------------------------------------------------------------------------
// Full session lifecycle
// ---------------------------------------------------------------------------

describe('full session lifecycle', () => {
  it('tracks a typical tmux -CC connection', () => {
    let state = emptyState();

    // Initial notifications from tmux -CC new-session
    state = applyEvent(state, {
      type: 'session-changed', sessionId: '$0', name: 'pocketshell',
    });

    state = applyEvent(state, {
      type: 'window-add', sessionId: '$0', windowId: '@0', name: '',
    });

    state = applyEvent(state, {
      type: 'layout-change', sessionId: '$0', windowId: '@0',
      layout: 'b25d,80x24,0,0{0}',
    });

    // Verify state
    expect(state.activeSessionId).toBe('$0');
    const session = state.sessions.get('$0')!;
    expect(session.name).toBe('pocketshell');
    expect(session.windows.size).toBe(1);
    expect(session.windows.get('@0')!.layout).toBe('b25d,80x24,0,0{0}');

    // Add a pane via list-panes response
    state = upsertPane(state, {
      id: '%0', sessionId: '$0', windowId: '@0',
      width: 80, height: 24, title: 'bash', mode: 'normal',
    });

    expect(allPanes(state).length).toBe(1);

    // Split the window
    state = upsertPane(state, {
      id: '%1', sessionId: '$0', windowId: '@0',
      width: 40, height: 24, title: 'vim', mode: 'normal',
    });

    expect(allPanes(state).length).toBe(2);

    // Rename window
    state = applyEvent(state, {
      type: 'window-renamed', sessionId: '$0', windowId: '@0', name: 'editor',
    });

    expect(state.sessions.get('$0')!.windows.get('@0')!.name).toBe('editor');

    // Close a pane
    state = removePane(state, '$0', '@0', '%1');
    expect(allPanes(state).length).toBe(1);
  });
});
