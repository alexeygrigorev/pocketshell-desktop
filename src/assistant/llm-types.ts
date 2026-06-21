/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unified, provider-independent conversation + tool-calling types for the
 * in-app action assistant.
 *
 * Ported from the Android app's `core-assistant` `LlmTypes.kt`. These shapes
 * carry exactly the slice of state the agent loop needs, decoupled from how
 * OpenAI or Anthropic represent it on the wire:
 *
 *  - System / user messages carry plain `text`.
 *  - Assistant messages carry optional `text` plus zero or more `toolCalls`.
 *  - Tool messages carry one or more `toolResults` feeding prior call outputs
 *    back to the model.
 *
 * The provider clients (OpenAiLlmClient, and later AnthropicLlmClient) translate
 * these onto the right wire shape. Kept pure / vscode-free so the mirror is
 * byte-identical (lesson #19) and the clients are unit-testable without the
 * extension host.
 */

/**
 * One conversation message. See file header for the role -> payload mapping.
 */
export interface LlmMessage {
	readonly role: LlmMessageRole;
	/** Optional plain-text content. `null` for a pure tool-call / tool-result turn. */
	readonly text: string | null;
	/** Tool invocations the assistant requested. Only meaningful on an Assistant message. */
	readonly toolCalls?: readonly LlmToolCall[];
	/** Outputs being fed back. Only meaningful on a Tool message. */
	readonly toolResults?: readonly LlmToolResult[];
}

export type LlmMessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** Convenience constructors. */
export const LlmMessage = {
	/** A plain system prompt. */
	system(text: string): LlmMessage {
		return { role: 'system', text };
	},
	/** A plain user turn. */
	user(text: string): LlmMessage {
		return { role: 'user', text };
	},
	/** A plain assistant text turn. */
	assistant(text: string): LlmMessage {
		return { role: 'assistant', text };
	},
	/** Carrying tool results back to the model. */
	toolResults(results: readonly LlmToolResult[]): LlmMessage {
		return { role: 'tool', text: null, toolResults: results };
	},
};

/**
 * A single tool invocation the model decided to make.
 *
 * `argumentsJson` is kept as a raw string (not a parsed object) so the host
 * owns parsing/validation against the tool's schema — different tools want
 * different argument types and a generic record loses fidelity.
 */
export interface LlmToolCall {
	/** Provider-assigned call id; must be echoed on the matching LlmToolResult. */
	readonly id: string;
	/** Tool name, matching a ToolSpec.name. */
	readonly name: string;
	/** Tool arguments as a raw JSON object string. */
	readonly argumentsJson: string;
}

/**
 * The output of running an LlmToolCall, fed back on the next turn. Anthropic
 * has a dedicated `is_error` flag; OpenAI conveys errors in `content`.
 */
export interface LlmToolResult {
	readonly toolCallId: string;
	readonly content: string;
	readonly isError?: boolean;
}

/**
 * Declares a tool the model may call. `parametersJsonSchema` is a JSON-Schema
 * object as a raw string — sent to OpenAI as `parameters` / Anthropic as
 * `input_schema`.
 */
export interface ToolSpec {
	readonly name: string;
	readonly description: string;
	readonly parametersJsonSchema: string;
}

/**
 * The unified result of one `AssistantLlmClient.complete` turn.
 */
export interface LlmResponse {
	/** Assistant text this turn, or null when the turn produced only tool calls. */
	readonly text: string | null;
	readonly toolCalls: readonly LlmToolCall[];
	readonly stopReason: StopReason;
}

export const LlmResponse = {
	isTextOnly(response: LlmResponse): boolean {
		return response.toolCalls.length === 0;
	},
};

/**
 * Why generation stopped, normalised across providers. Anthropic reports
 * `end_turn` / `tool_use` / `max_tokens`; OpenAI reports `stop` / `tool_calls`
 * / `length`. Anything unrecognised maps to `other`.
 */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

/**
 * How the model is allowed to use the supplied ToolSpecs this turn. A small
 * union rather than a string so callers can't pass a value one provider
 * understands and the other doesn't.
 */
export type ToolChoice =
	| { kind: 'auto' }
	| { kind: 'none' }
	| { kind: 'required' }
	| { kind: 'specific'; toolName: string };

/**
 * Errors from an AssistantLlmClient call. Callers branch on the `kind` rather
 * than raw HTTP codes — same convention as the app's `AssistantLlmException`
 * sealed class. The message never carries the API key.
 */
export type AssistantLlmError =
	| { kind: 'auth'; message: string }
	| { kind: 'rate_limited'; message: string; retryAfterSeconds?: number }
	| { kind: 'server'; message: string; statusCode: number }
	| { kind: 'transport'; message: string }
	| { kind: 'parse'; message: string }
	| { kind: 'timeout'; message: string };

/** A failed complete() carries an AssistantLlmError; success carries LlmResponse. */
export type CompleteResult = { ok: true; response: LlmResponse } | { ok: false; error: AssistantLlmError };

/**
 * Resolved configuration for one provider: API key plus base URL and model.
 *
 * The key flows only `SecretStorage` -> in-memory -> Authorization header on
 * the desktop port (never logged, never persisted to plaintext settings).
 */
export interface AssistantProviderConfig {
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly model: string;
	readonly maxTokens?: number;
}

export const DEFAULT_MAX_TOKENS = 4096;

/**
 * Which provider family the assistant talks to. Product-facing providers are
 * kept separate from wire protocols: `zai` uses the Anthropic-compatible
 * Messages protocol internally, but has its own settings + secret slot.
 *
 * Note: Dispatch 1 ships the OpenAI client only; `anthropic`/`zai` arrive in
 * Dispatch 3. The enum is declared now so the config store is stable.
 */
export type AssistantProvider = 'openai' | 'anthropic' | 'zai';

/** Default provider on a fresh install. Decision (app D25): OpenAI. */
export const DEFAULT_PROVIDER: AssistantProvider = 'openai';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-latest';
export const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/anthropic/v1';
export const DEFAULT_ZAI_MODEL = 'glm-4.6';

/**
 * Parse a persisted provider name, defaulting to DEFAULT_PROVIDER for unknown /
 * missing values so a hand-edited config can never crash the factory.
 */
export function providerFromName(name: string | undefined | null): AssistantProvider {
	if (name === 'openai' || name === 'anthropic' || name === 'zai') {
		return name;
	}
	return DEFAULT_PROVIDER;
}
