import { describe, it, expect } from 'vitest';
import { getKillTargetFromTmuxTreeNode, getTmuxTreeChildren, type TmuxTreeSessionEntry } from '../../../src/tmux-ui/tree-model';

function entry(): TmuxTreeSessionEntry {
  return {
    id: 'entry-1',
    label: 'devhost: pocketshell',
    hostId: 42,
    sessionName: 'pocketshell',
    snapshot: {
      activeSessionId: '$0',
      activeWindowId: '@0',
      activePaneId: '%1',
      sessions: [
        {
          id: '$0',
          name: 'main',
          isActive: true,
          windows: [
            {
              id: '@0',
              sessionId: '$0',
              name: 'editor',
              isActive: true,
              layout: '',
              panes: [
                {
                  id: '%1',
                  sessionId: '$0',
                  windowId: '@0',
                  width: 120,
                  height: 40,
                  title: 'vim',
                  mode: 'normal',
                  cwd: '/work/app',
                  hasTerminal: false,
                  terminalId: undefined,
                  isActive: true,
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe('tmux tree model', () => {
  it('builds root, session, window, and pane nodes with cwd and active state preserved', () => {
    const roots = getTmuxTreeChildren([entry()]);
    expect(roots).toEqual([
      {
        kind: 'root',
        entryId: 'entry-1',
        hostId: 42,
        label: 'devhost: pocketshell',
        description: 'active %1',
        sessionName: 'pocketshell',
      },
    ]);

    const sessions = getTmuxTreeChildren([entry()], roots[0]);
    expect(sessions[0].kind).toBe('session');

    const windows = getTmuxTreeChildren([entry()], sessions[0]);
    expect(windows[0].kind).toBe('window');

    const panes = getTmuxTreeChildren([entry()], windows[0]);
    expect(panes[0].kind).toBe('pane');
    if (panes[0].kind === 'pane') {
      expect(panes[0].pane.cwd).toBe('/work/app');
      expect(panes[0].pane.isActive).toBe(true);
    }
  });

  it('resolves a window node kill target as the window, not its active pane', () => {
    const roots = getTmuxTreeChildren([entry()]);
    const sessions = getTmuxTreeChildren([entry()], roots[0]);
    const windows = getTmuxTreeChildren([entry()], sessions[0]);

    expect(getKillTargetFromTmuxTreeNode(windows[0])).toEqual({
      kind: 'window',
      id: '@0',
      label: 'editor',
    });
  });
});
