/**
 * Agents module for PocketShell Desktop.
 *
 * Exposes AI coding-agent detection over SSH. The conversation submodule
 * (`./conversation`) is re-exported separately from its own barrel.
 */

export { AgentDetector, parseVersion } from './agent-detector';
export { AgentType, AGENT_METADATA } from './types';
export type { DetectedAgent } from './types';
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
