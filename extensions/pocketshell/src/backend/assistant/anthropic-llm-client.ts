/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as https from 'https';
import * as http from 'http';
import type { AssistantLlmClient, LlmHttpTransport } from './assistant-llm-client';
import { transportError } from './assistant-llm-client';
import type {
	AssistantLlmError,
	AssistantProviderConfig,
	CompleteResult,
	LlmMessage,
	LlmToolCall,
	LlmResponse,
	StopReason,
	ToolChoice,
	ToolSpec,
} from './llm-types';
import { DEFAULT_MAX_TOKENS } from './llm-types';

/**
 * AssistantLlmClient backed by the Anthropic Messages API
 * (`POST <baseUrl>/messages`).
 *
 * The same wire implementation serves both real Anthropic and ZAI. ZAI is
 * product-configured as its own provider, then routed here because its API
 * exposes the Anthropic-compatible Messages protocol at
 * `https://api.z.ai/api/anthropic/v1` with `glm-*` models (app decision D25).
 *
 * Wire mapping (ported verbatim from `AnthropicLlmClient.kt`):
 *  - System messages -> top-level `system` string (Anthropic does NOT accept a
 *    `system` role inside `messages`). Every System message is concatenated
 *    (newline-joined) so callers can split a long prompt across messages.
 *  - User / assistant text -> `messages[]` with `content` blocks.
 *  - Assistant tool calls -> `tool_use` content blocks.
 *  - Tool results -> a `user` message whose content is `tool_result` blocks
 *    keyed by `tool_use_id`.
 *  - ToolSpec -> `tools[]` with `input_schema`.
 *  - ToolChoice -> `tool_choice` object (Required maps to `{type:"any"}`).
 *
 * Single-shot: no streaming (`stream` omitted, defaults false).
 *
 * Security: the API key flows only SecretStorage -> in-memory config ->
 * `x-api-key` header. It is never logged, never written to settings /
 * OutputChannel / trace events. Kept pure / vscode-free so the mirror is
 * byte-identical (lesson #19) and the client is unit-testable without the
 * extension host.
 */
export const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicLlmClient implements AssistantLlmClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly model: string;
	private readonly maxTokens: number;
	private readonly transport: LlmHttpTransport;
	private readonly timeoutMs: number;

	constructor(config: AssistantProviderConfig, transport?: LlmHttpTransport, timeoutMs?: number) {
		this.apiKey = config.apiKey;
		this.baseUrl = config.baseUrl;
		this.model = config.model;
		this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
		this.transport = transport ?? nodeHttpsTransport;
		this.timeoutMs = timeoutMs ?? 60_000;
	}

	async complete(
		messages: readonly LlmMessage[],
		tools?: readonly ToolSpec[],
		toolChoice?: ToolChoice | undefined,
	): Promise<CompleteResult> {
		const body = buildAnthropicRequest(messages, tools ?? [], toolChoice, this.model, this.maxTokens);
		const url = anthropicMessagesUrl(this.baseUrl);
		const headers: Record<string, string> = {
			'x-api-key': this.apiKey,
			'anthropic-version': ANTHROPIC_VERSION,
			'Content-Type': 'application/json; charset=utf-8',
			'Accept': 'application/json',
		};

		let raw: { statusCode: number; body: string; headers: Record<string, string | string[] | undefined> };
		try {
			raw = await this.transport.post(url, headers, body, this.timeoutMs);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: transportError(message) };
		}

		if (raw.statusCode < 200 || raw.statusCode >= 300) {
			return { ok: false, error: classifyHttpFailure(raw.statusCode, headerValue(raw.headers, 'retry-after'), raw.body) };
		}
		return parseAnthropicResponse(raw.body);
	}
}

/**
 * Build the JSON body for the Anthropic Messages API. Exposed at module scope
 * (matches the Kotlin file-scope `buildAnthropicRequest`) so a unit test can
 * assert the request shape directly without a mock server. Must match the
 * Anthropic wire format EXACTLY.
 */
export function buildAnthropicRequest(
	messages: readonly LlmMessage[],
	tools: readonly ToolSpec[],
	toolChoice: ToolChoice | undefined,
	model: string,
	maxTokens: number,
): string {
	const root: Record<string, unknown> = {
		model,
		max_tokens: maxTokens,
	};

	// Anthropic carries the system prompt as a top-level field, NOT a message
	// role. Concatenate every System message (newline-joined) so callers can
	// split a long prompt across messages if they like.
	const systemText = messages
		.filter((m) => m.role === 'system')
		.map((m) => m.text ?? '')
		.filter((t) => t.length > 0)
		.join('\n');
	if (systemText.length > 0) {
		root.system = systemText;
	}

	const wireMessages: unknown[] = [];
	for (const message of messages) {
		switch (message.role) {
			case 'system':
				// Handled above as the top-level `system` field.
				break;
			case 'user':
				wireMessages.push({
					role: 'user',
					content: textContentBlocks(message.text),
				});
				break;
			case 'assistant': {
				const content: unknown[] = [];
				if (message.text !== null && message.text !== undefined && message.text.length > 0) {
					content.push({ type: 'text', text: message.text });
				}
				if (message.toolCalls) {
					for (const call of message.toolCalls) {
						content.push({
							type: 'tool_use',
							id: call.id,
							name: call.name,
							input: parseArgumentsObject(call.argumentsJson),
						});
					}
				}
				wireMessages.push({ role: 'assistant', content });
				break;
			}
			case 'tool': {
				// Anthropic feeds tool results back INSIDE a `user` message, as
				// `tool_result` content blocks keyed by `tool_use_id`.
				const content: unknown[] = [];
				const results = message.toolResults ?? [];
				for (const result of results) {
					content.push({
						type: 'tool_result',
						tool_use_id: result.toolCallId,
						content: result.content,
						is_error: result.isError === true,
					});
				}
				wireMessages.push({ role: 'user', content });
				break;
			}
		}
	}
	root.messages = wireMessages;

	if (tools.length > 0) {
		root.tools = tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: JSON.parse(tool.parametersJsonSchema),
		}));
	}

	if (toolChoice) {
		switch (toolChoice.kind) {
			case 'auto':
				root.tool_choice = { type: 'auto' };
				break;
			case 'none':
				root.tool_choice = { type: 'none' };
				break;
			// Anthropic has no "required" — "any" forces a tool call.
			case 'required':
				root.tool_choice = { type: 'any' };
				break;
			case 'specific':
				root.tool_choice = { type: 'tool', name: toolChoice.toolName };
				break;
		}
	}

	return JSON.stringify(root);
}

/**
 * Parse a successful Anthropic Messages response body into the unified
 * LlmResponse. Exposed at module scope for direct unit testing.
 */
export function parseAnthropicResponse(body: string): CompleteResult {
	let root: any;
	try {
		root = JSON.parse(body);
	} catch (json) {
		return { ok: false, error: { kind: 'parse', message: 'Anthropic returned malformed JSON' } };
	}

	const contentArray = root?.content;
	if (!Array.isArray(contentArray)) {
		return { ok: false, error: { kind: 'parse', message: 'Anthropic response did not contain a content array' } };
	}

	const textParts: string[] = [];
	const toolCalls: LlmToolCall[] = [];
	for (const block of contentArray) {
		if (!block || typeof block !== 'object') continue;
		const type = (block as { type?: unknown }).type;
		if (type === 'text') {
			const t = (block as { text?: unknown }).text;
			if (typeof t === 'string' && t.length > 0) {
				textParts.push(t);
			}
		} else if (type === 'tool_use') {
			const input = (block as { input?: unknown }).input;
			const inputObj = (input !== null && typeof input === 'object') ? input : {};
			toolCalls.push({
				id: String((block as { id?: unknown }).id ?? ''),
				name: String((block as { name?: unknown }).name ?? ''),
				argumentsJson: JSON.stringify(inputObj),
			});
		}
	}

	const stopReason = mapStopReason(root?.stop_reason);

	const response: LlmResponse = {
		text: textParts.length > 0 ? textParts.join('\n') : null,
		toolCalls,
		stopReason,
	};
	return { ok: true, response };
}

function mapStopReason(stopReason: unknown): StopReason {
	switch (stopReason) {
		case 'end_turn':
		case 'stop_sequence':
			return 'end_turn';
		case 'tool_use':
			return 'tool_use';
		case 'max_tokens':
			return 'max_tokens';
		default:
			return 'other';
	}
}

function classifyHttpFailure(code: number, retryAfter: string | undefined, body: string): AssistantLlmError {
	const snippet = (body ?? '').slice(0, 200);
	if (code === 401 || code === 403) {
		return { kind: 'auth', message: `Anthropic rejected credentials (HTTP ${code}): ${snippet}` };
	}
	if (code === 429) {
		const retryAfterSeconds = retryAfter ? parseRetryAfter(retryAfter) : undefined;
		return { kind: 'rate_limited', message: `Anthropic rate limit hit (HTTP 429): ${snippet}`, retryAfterSeconds };
	}
	if (code >= 500 && code <= 599) {
		return { kind: 'server', message: `Anthropic server error (HTTP ${code}): ${snippet}`, statusCode: code };
	}
	return { kind: 'transport', message: `Anthropic returned unexpected HTTP ${code}: ${snippet}` };
}

function parseRetryAfter(value: string): number | undefined {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : undefined;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
	// Header lookup is case-insensitive.
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) {
			const v = headers[key];
			if (Array.isArray(v)) return v[0];
			return v;
		}
	}
	return undefined;
}

/**
 * Build the request URL for the Anthropic Messages API from a base URL.
 *
 * ZAI exposes its Anthropic-compatible API rooted at
 * `https://api.z.ai/api/anthropic` (no `/v1`); appending `/v1/messages` lands
 * on the documented live path. A base URL that already includes `/v1`
 * (Anthropic proper, or a ZAI base pre-suffixed with `/v1`) gets `/messages`
 * appended directly. A trailing slash is trimmed first.
 */
export function anthropicMessagesUrl(baseUrl: string): string {
	const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
	if (isZaiAnthropicRoot(trimmed)) {
		return `${trimmed}/v1/messages`;
	}
	return `${trimmed}/messages`;
}

function isZaiAnthropicRoot(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const path = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
	return parsed.host === 'api.z.ai' && path === '/api/anthropic';
}

function textContentBlocks(text: string | null | undefined): unknown[] {
	return [{ type: 'text', text: text ?? '' }];
}

/**
 * Parse a tool-call arguments JSON string into an object for the `input`
 * field. An empty / blank / malformed string degrades to `{}` so a model that
 * emitted no arguments still produces a valid request.
 */
function parseArgumentsObject(argumentsJson: string): unknown {
	if (!argumentsJson || argumentsJson.trim() === '') return {};
	try {
		return JSON.parse(argumentsJson);
	} catch {
		return {};
	}
}

/**
 * Production LlmHttpTransport backed by node `https`/`http`. Mirrors the app's
 * OkHttp timeouts (connect 15s, call 60s, read 60s, write 30s); the call-level
 * timeout is enforced via the passed `timeoutMs`. Identical to the OpenAI
 * client's transport (kept here so the Anthropic client is self-contained +
 * pure/vscode-free).
 */
export const nodeHttpsTransport: LlmHttpTransport = {
	post(url, headers, body, timeoutMs): Promise<{ statusCode: number; body: string; headers: Record<string, string | string[] | undefined> }> {
		return new Promise((resolve, reject) => {
			const lib = url.startsWith('https:') ? https : http;
			const parsedUrl = new URL(url);
			const req = lib.request(
				{
					method: 'POST',
					hostname: parsedUrl.hostname,
					port: parsedUrl.port || undefined,
					path: parsedUrl.pathname + parsedUrl.search,
					headers,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on('data', (chunk: Buffer) => chunks.push(chunk));
					res.on('end', () => {
						const responseBody = Buffer.concat(chunks).toString('utf8');
						resolve({
							statusCode: res.statusCode ?? 0,
							body: responseBody,
							headers: res.headers as Record<string, string | string[] | undefined>,
						});
					});
					res.on('error', reject);
				},
			);
			req.on('error', reject);
			req.setTimeout(timeoutMs, () => {
				req.destroy(new Error(`Anthropic request timed out after ${timeoutMs}ms`));
			});
			req.write(body);
			req.end();
		});
	},
};
