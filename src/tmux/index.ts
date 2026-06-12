/**
 * tmux -CC Control Mode Client Module
 *
 * Public API for the tmux integration.
 */

export type {
  ControlEvent,
  OutputEvent,
  SessionChangedEvent,
  SessionsChangedEvent,
  WindowAddEvent,
  WindowCloseEvent,
  WindowRenamedEvent,
  LayoutChangeEvent,
  PaneModeChangedEvent,
  BeginEvent,
  EndEvent,
  ErrorEvent,
  ClientDetachedEvent,
  ExitEvent,
  CommandResponse,
  CaptureWithCursor,
} from './events';

export {
  parseLine,
  normalizeControlLineBytes,
  decodeOutputData,
} from './parser';

export {
  TmuxEventStream,
  type StreamReader,
  type PendingCommand,
} from './stream';

export {
  TmuxClient,
  type SshChannel,
  type TmuxClientOptions,
  type OutputSubscription,
} from './client';

export type {
  TmuxPane,
  TmuxWindow,
  TmuxSession,
  TmuxState,
} from './state';

export {
  emptyState,
  applyEvent,
  upsertPane,
  removePane,
  setActiveWindow,
  allPanes,
} from './state';
