/**
 * Tmux UI Module
 *
 * Public API for the tmux management UI layer.
 */

export type {
  SplitDirection,
  TmuxPaneInfo,
  TmuxWindowInfo,
  TmuxSessionInfo,
  TmuxTreeSnapshot,
} from './types';

export { buildSnapshot } from './snapshot-builder';

export { TmuxSessionManager } from './tmux-session-manager';
export { ActivePaneTerminalController, selectActivePane, type ActivePaneTerminalClient } from './active-pane-terminal';
