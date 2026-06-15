/**
 * Agent conversation module — types, parsers, and session reading.
 */

export {
  AgentType,
  ConversationMessage,
  ConversationSession,
  SessionInfo,
} from './types';

export { parseSession, parseClaudeSession, parseCodexSession, parseOpenCodeSession } from './parsers';

export { SessionReader } from './session-reader';

export {
  appendConversationMessage,
  clearConversationSearch,
  createConversationPanelModel,
  createQuoteReplyPayload,
  insertQuoteIntoDraft,
  markComposerQueued,
  markComposerQueuedReplySent,
  markComposerSendFailed,
  markComposerSendSucceeded,
  markComposerSending,
  messagePlainText,
  navigateConversationSearch,
  persistComposerDraftState,
  quotePayloadTargetsPanel,
  renderConversationHtml,
  renderMarkdown,
  sessionPlainText,
  shouldClearComposerDraft,
  updateConversationComposer,
  updateConversationSearch,
} from './panel-model';
export type {
  ConversationComposerLastStatus,
  ConversationComposerState,
  ConversationHtmlRenderOptions,
  ConversationPanelModel,
  ConversationSearchMatch,
  ConversationSearchState,
  ConversationWebviewState,
  QuoteReplyPayload,
} from './panel-model';
