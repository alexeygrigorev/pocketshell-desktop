import { describe, expect, it } from 'vitest';
import {
  decideTmuxStartupRestore,
  parseTmuxRestoreTarget,
  readTmuxRestoreSettings,
  serializeTmuxRestoreTarget,
  targetFromSnapshot,
  type TmuxRestoreTarget,
} from '../../../src/tmux-ui/restore-state';
import type { TmuxTreeSnapshot } from '../../../src/tmux-ui/types';

describe('tmux restore state', () => {
  const target: TmuxRestoreTarget = {
    hostId: 7,
    hostLabel: 'devbox',
    sessionName: 'work',
    sessionId: '$1',
    windowId: '@2',
    paneId: '%3',
    cwd: '/home/me/project',
    path: '/home/me/project',
    updatedAt: 1234,
  };

  it('round-trips valid restore targets through plain storage objects', () => {
    expect(parseTmuxRestoreTarget(serializeTmuxRestoreTarget(target))).toEqual(target);
  });

  it('rejects missing host or session data', () => {
    expect(parseTmuxRestoreTarget(null)).toBeNull();
    expect(parseTmuxRestoreTarget({ sessionName: 'work' })).toBeNull();
    expect(parseTmuxRestoreTarget({ hostId: 1, sessionName: '' })).toBeNull();
    expect(parseTmuxRestoreTarget({ hostId: -1, sessionName: 'work' })).toBeNull();
  });

  it('decides startup restore from existing settings semantics', () => {
    expect(decideTmuxStartupRestore({
      enabled: false,
      behavior: 'ask',
      target,
      hostReady: true,
    })).toEqual({ action: 'skip', reason: 'disabled' });

    expect(decideTmuxStartupRestore({
      enabled: true,
      behavior: 'skip',
      target,
      hostReady: true,
    })).toEqual({ action: 'skip', reason: 'user-skip' });

    expect(decideTmuxStartupRestore({
      enabled: true,
      behavior: 'restore-ready',
      target,
      hostReady: false,
    })).toEqual({ action: 'skip', reason: 'host-not-ready' });

    expect(decideTmuxStartupRestore({
      enabled: true,
      behavior: 'ask',
      target,
      hostReady: false,
    })).toEqual({ action: 'ask', target });

    expect(decideTmuxStartupRestore({
      enabled: true,
      behavior: 'restore-ready',
      target,
      hostReady: true,
    })).toEqual({ action: 'restore', target });
  });

  it('normalizes restore settings from the app settings store values', () => {
    expect(readTmuxRestoreSettings({
      restoreSessionOnStartup: false,
      sessionRestoreBehavior: 'restore-ready',
    })).toEqual({
      restoreSessionOnStartup: false,
      sessionRestoreBehavior: 'restore-ready',
    });

    expect(readTmuxRestoreSettings({
      restoreSessionOnStartup: 'false',
      sessionRestoreBehavior: 'unknown',
    })).toEqual({
      restoreSessionOnStartup: true,
      sessionRestoreBehavior: 'ask',
    });

    expect(readTmuxRestoreSettings(undefined)).toEqual({
      restoreSessionOnStartup: true,
      sessionRestoreBehavior: 'ask',
    });
  });

  it('derives the active target from a live tree snapshot', () => {
    const snapshot: TmuxTreeSnapshot = {
      activeSessionId: '$1',
      activeWindowId: '@2',
      activePaneId: '%3',
      sessions: [
        {
          id: '$1',
          name: 'work',
          isActive: true,
          windows: [
            {
              id: '@2',
              sessionId: '$1',
              name: 'editor',
              isActive: true,
              layout: '',
              panes: [
                {
                  id: '%3',
                  sessionId: '$1',
                  windowId: '@2',
                  width: 120,
                  height: 40,
                  title: 'nvim',
                  mode: 'normal',
                  cwd: '/repo',
                  hasTerminal: false,
                  terminalId: undefined,
                  isActive: true,
                },
              ],
            },
          ],
        },
      ],
    };

    expect(targetFromSnapshot({
      hostId: 7,
      hostLabel: 'devbox',
      sessionName: 'old',
      path: '/repo',
    }, snapshot, 99)).toEqual({
      hostId: 7,
      hostLabel: 'devbox',
      sessionName: 'work',
      sessionId: '$1',
      windowId: '@2',
      paneId: '%3',
      cwd: '/repo',
      path: '/repo',
      updatedAt: 99,
    });
  });
});
