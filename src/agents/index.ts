/**
 * Agent detection barrel export.
 */

export { AgentType, AGENT_METADATA } from './types';
export type { DetectedAgent } from './types';
export { AgentDetector, parseVersion } from './agent-detector';
export { PocketshellAgentDetector } from './pocketshell-detector';
export {
  ConversationAttributionService,
  conversationPaneKey,
  cwdFromSessionPath,
  cwdFromSessionContent,
  detectAgentTypeFromCommand,
  detectAgentTypeFromProcess,
  enrichActivePaneConversationContext,
  enrichConversationSessions,
  enrichSessionsFromAgentDetections,
  parseAgentDetectionRows,
  parseProcessEvidenceRows,
} from './conversation-attribution';
export type {
  ActivePaneConversationContext,
  AgentDetectionRow,
  AttributableConversationSession,
  ConversationAttributionKind,
  ConversationAttributionResult,
  ConversationSessionEnrichmentOptions,
  ProcessEvidenceRow,
} from './conversation-attribution';
