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
  messagePlainText,
  navigateConversationSearch,
  renderConversationHtml,
  renderMarkdown,
  sessionPlainText,
  updateConversationSearch,
} from './panel-model';
export type {
  ConversationHtmlRenderOptions,
  ConversationPanelModel,
  ConversationSearchMatch,
  ConversationSearchState,
  QuoteReplyPayload,
} from './panel-model';
