/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	AssistantLlmError,
	CompleteResult,
	LlmMessage,
	LlmResponse,
	ToolChoice,
	ToolSpec,
} from './llm-types';

/**
 * Provider-agnostic single-shot chat-completion client for the in-app action
 * assistant (the agent loop builds multi-turn behaviour on top).
 *
 * The whole point of this interface is that the **caller never sees a
 * provider's wire format**. Anthropic encodes tool calls as `tool_use` content
 * blocks and tool results as `tool_result` blocks; OpenAI encodes the same
 * concepts as `tool_calls` on an assistant message and `role: "tool"`
 * messages. Both collapse into the unified shapes in `llm-types.ts` so the
 * agent loop can be written once and run against either provider.
 *
 * Single-shot only for v1: no streaming surface. The agent loop drives
 * multi-turn behaviour by calling `complete` repeatedly with the growing
 * message list — this client just maps one request to one response.
 *
 * Ported from the Android app's `core-assistant` `AssistantLlmClient.kt`.
 * Kept pure / vscode-free so the mirror is byte-identical (lesson #19) and the
 * client is unit-testable without the extension host.
 */
export interface AssistantLlmClient {
	/**
	 * Run one completion turn.
	 *
	 * @param messages the full conversation so far, oldest first. Tool results
	 *   from a previous turn are carried as LlmMessages with role 'tool'; the
	 *   client maps them onto whatever shape the provider expects.
	 * @param tools the tools the model is allowed to call this turn. Empty
	 *   means "plain completion, no tools offered".
	 * @param toolChoice optional constraint on tool usage. `undefined` lets the
	 *   provider decide (its default — usually "auto").
	 * @returns `{ok:true}` with an LlmResponse, or `{ok:false}` carrying an
	 *   AssistantLlmError. Callers branch on the `kind`, not on raw HTTP codes.
	 */
	complete(
		messages: readonly LlmMessage[],
		tools?: readonly ToolSpec[],
		toolChoice?: ToolChoice | undefined,
	): Promise<CompleteResult>;
}

/**
 * Transport seam injected into the OpenAI client so tests can fake the HTTP
 * layer without standing up a real socket. Production wires up the
 * node `https`/`http` request adapter in `openai-llm-client.ts`.
 *
 * The request body is already the exact JSON string to send; the response is
 * the exact JSON string the server returned (or the call rejects on
 * network/timeout error).
 */
export interface LlmHttpTransport {
	/**
	 * POST `url` with `headers` and `body`, resolving the response body string.
	 * Rejects with an Error on DNS/connect/TLS/timeout/cancellation failure.
	 */
	post(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{ statusCode: number; body: string; headers: Record<string, string | string[] | undefined> }>;
}

/**
 * Map a raw transport error message onto a transport AssistantLlmError. Kept
 * here so both the client and tests share one mapping.
 */
export function transportError(message: string): AssistantLlmError {
	return { kind: 'transport', message: message || 'Transport failure' };
}

/** Narrow helper used by the agent loop's retry classification. */
export function isRetryable(error: AssistantLlmError): boolean {
	return error.kind === 'transport' || error.kind === 'server' || error.kind === 'rate_limited' || error.kind === 'timeout';
}

/** Re-export the unified types so consumers can import from one entry. */
export type { AssistantLlmError, CompleteResult, LlmMessage, LlmResponse, ToolChoice, ToolSpec };
