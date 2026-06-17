/**
 * Conversation launcher sidebar module — types, state machine, and rendering.
 */

export {
  createLauncherPanelModel,
  applySessionAttribution,
  markOpeningConversation,
  markOpeningComposer,
  markOpenSucceeded,
  markOpenFailed,
  resetLauncherStatus,
  canLaunch,
  launcherTitle,
  buildConversationOpenElement,
  buildComposerOpenArgs,
  renderLauncherHtml,
} from './launcher-model';
export type {
  LauncherAgentType,
  LauncherSessionHint,
  LauncherStatus,
  LauncherStatusKind,
  LauncherPanelModel,
  LauncherHtmlRenderOptions,
} from './launcher-model';
