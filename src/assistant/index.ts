/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Barrel for the canonical, vscode-free action-assistant core. Every module
 * here is mirrored byte-identical to
 * `extensions/pocketshell/src/backend/assistant/` (lesson #19). The
 * vscode-dependent glue (desktop actions, config store, commands) lives in the
 * feature layer (`feature/assistant/`), NOT here.
 */

export type {
	AssistantLlmError,
	AssistantProvider,
	AssistantProviderConfig,
	CompleteResult,
	LlmMessageRole,
	LlmToolCall,
	LlmToolResult,
	StopReason,
	ToolChoice,
	ToolSpec,
} from './llm-types';
export {
	DEFAULT_ANTHROPIC_BASE_URL,
	DEFAULT_ANTHROPIC_MODEL,
	DEFAULT_MAX_TOKENS,
	DEFAULT_OPENAI_BASE_URL,
	DEFAULT_OPENAI_MODEL,
	DEFAULT_PROVIDER,
	DEFAULT_ZAI_BASE_URL,
	DEFAULT_ZAI_MODEL,
	LlmMessage,
	LlmResponse,
	providerFromName,
} from './llm-types';

export type { AssistantLlmClient, LlmHttpTransport } from './assistant-llm-client';
export { isRetryable, transportError } from './assistant-llm-client';

export { OpenAiLlmClient, buildOpenAiRequest, nodeHttpsTransport, parseOpenAiResponse } from './openai-llm-client';

export {
	ANTHROPIC_VERSION,
	AnthropicLlmClient,
	anthropicMessagesUrl,
	buildAnthropicRequest,
	parseAnthropicResponse,
} from './anthropic-llm-client';

export { DEFAULT_FORBIDDEN_PATTERNS, MAX_COMMAND_LENGTH, rejectCommand } from './command-safety';

export type { FolderCandidate, FolderResolution } from './folder-resolver';
export { resolveFolder } from './folder-resolver';

export type { AssistantAgentName } from './mutating-helpers';
export {
	buildCloneTarget,
	buildCloneUrl,
	buildCreatedPath,
	buildCreateFileHeredoc,
	buildMkdirCommand,
	CREATE_FILE_HEREDOC_DELIMITER,
	hasPathTraversal,
	isSafeFolderName,
	joinPath,
	mapAgentNameToSessionKind,
	repoNameFromFullName,
	shellQuote,
} from './mutating-helpers';

export type { FolderResolutionResult } from './assistant-actions';
export type { AssistantActions } from './assistant-actions';
export { ActionResult } from './assistant-actions';

export {
	ASSISTANT_TOOLS,
	CLONE_REPO,
	CREATE_FILE,
	CREATE_PROJECT,
	GET_CONTEXT,
	LIST_DIRECTORY,
	LIST_FOLDERS,
	LIST_HOSTS,
	LIST_REPOS,
	LIST_SESSIONS,
	MUTATING_TOOLS,
	OPEN_FOLDER,
	OPEN_SCREEN,
	OPEN_SESSION,
	READ_FILE,
	RESOLVE_FOLDER,
	RUN_COMMAND,
	SEND_PROMPT_TO_SESSION,
	START_SESSION,
	SYSTEM_PROMPT,
	isMutating,
} from './assistant-tools';

export type {
	ChoiceDecision,
	ChoiceGate,
	Candidate,
	ConfirmGate,
	Decision,
	Outcome,
} from './assistant-agent-loop';
export { AssistantAgentLoop } from './assistant-agent-loop';

export type { AssistantTraceEvent, AssistantTraceSink } from './assistant-trace';
export { NOOP_TRACE_SINK, REDACTED, traceEventToJson } from './assistant-trace';
