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
export { buildTmuxTreeRoots, getTmuxTreeChildren, getKillTargetFromTmuxTreeNode } from './tree-model';
export type { TmuxTreeNode, TmuxTreeSessionEntry, TmuxTreeKillTarget } from './tree-model';
export {
  decideTmuxStartupRestore,
  parseTmuxRestoreTarget,
  readTmuxRestoreSettings,
  serializeTmuxRestoreTarget,
  targetFromSnapshot,
} from './restore-state';
export type { RestoreDecision, TmuxRestoreSettings, TmuxRestoreTarget, TmuxSessionRestoreBehavior } from './restore-state';

export { TmuxSessionManager } from './tmux-session-manager';
export { ActivePaneTerminalController, paneMetadata, selectActivePane, type ActivePaneTerminalClient } from './active-pane-terminal';
