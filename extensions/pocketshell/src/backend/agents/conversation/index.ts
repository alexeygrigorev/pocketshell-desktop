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
	createConversationPanelModel,
	createQuoteReplyPayload,
	messagePlainText,
	renderConversationHtml,
	renderMarkdown,
	sessionPlainText,
} from './panel-model';
export type { ConversationHtmlRenderOptions, ConversationPanelModel, QuoteReplyPayload } from './panel-model';
