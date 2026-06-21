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
	LlmToolResult,
	LlmResponse,
	StopReason,
	ToolChoice,
	ToolSpec,
} from './llm-types';
import { DEFAULT_MAX_TOKENS } from './llm-types';

/**
 * AssistantLlmClient backed by the OpenAI Chat Completions API
 * (`POST <baseUrl>/chat/completions`) with function/tool calling.
 *
 * Base URL is injectable so the same impl can target OpenAI proper or any
 * OpenAI-compatible gateway. Anthropic and ZAI go through AnthropicLlmClient
 * instead because they use the Messages wire format (app decision D25).
 *
 * Wire mapping (ported verbatim from `OpenAiLlmClient.kt`):
 *  - System / user / assistant text -> `messages[]` with matching `role`.
 *  - Assistant tool calls -> `tool_calls[]` on the assistant message.
 *  - Tool results -> `role: "tool"` messages keyed by `tool_call_id`.
 *  - ToolSpec -> `tools[]` of `type: "function"`.
 *  - ToolChoice -> `tool_choice`.
 *
 * Single-shot: no streaming (`stream` omitted, defaults false).
 *
 * Security: the API key flows only SecretStorage -> in-memory config ->
 * `Authorization: Bearer` header. It is never logged, never written to
 * settings/OutputChannel/trace events.
 */
export class OpenAiLlmClient implements AssistantLlmClient {
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
		const body = buildOpenAiRequest(messages, tools ?? [], toolChoice, this.model, this.maxTokens);
		const url = trimTrailingSlash(this.baseUrl) + '/chat/completions';
		const headers: Record<string, string> = {
			'Authorization': `Bearer ${this.apiKey}`,
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
		return parseOpenAiResponse(raw.body);
	}
}

/**
 * Build the JSON body for the OpenAI Chat Completions API. Exposed at module
 * scope for direct request-shape unit testing (matches the Kotlin file-scope
 * `buildOpenAiRequest`). Must match the OpenAI wire format EXACTLY.
 */
export function buildOpenAiRequest(
	messages: readonly LlmMessage[],
	tools: readonly ToolSpec[],
	toolChoice: ToolChoice | undefined,
	model: string,
	maxTokens: number,
): string {
	const wireMessages: unknown[] = [];
	for (const message of messages) {
		switch (message.role) {
			case 'system':
				wireMessages.push({ role: 'system', content: message.text ?? '' });
				break;
			case 'user':
				wireMessages.push({ role: 'user', content: message.text ?? '' });
				break;
			case 'assistant': {
				// OpenAI requires `content` present even when only tool calls are
				// made; null is the documented value for a pure-tool turn.
				const obj: Record<string, unknown> = {
					role: 'assistant',
					content: message.text === null || message.text === undefined ? null : message.text,
				};
				if (message.toolCalls && message.toolCalls.length > 0) {
					obj.tool_calls = message.toolCalls.map((call) => ({
						id: call.id,
						type: 'function',
						function: {
							name: call.name,
							arguments: call.argumentsJson && call.argumentsJson.trim() !== '' ? call.argumentsJson : '{}',
						},
					}));
				}
				wireMessages.push(obj);
				break;
			}
			case 'tool': {
				// OpenAI emits one `role: "tool"` message per result.
				const results = message.toolResults ?? [];
				for (const result of results) {
					wireMessages.push({
						role: 'tool',
						tool_call_id: result.toolCallId,
						content: result.content,
					});
				}
				break;
			}
		}
	}

	const root: Record<string, unknown> = {
		model,
		max_tokens: maxTokens,
		messages: wireMessages,
	};

	if (tools.length > 0) {
		root.tools = tools.map((tool) => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: JSON.parse(tool.parametersJsonSchema),
			},
		}));
	}

	if (toolChoice) {
		switch (toolChoice.kind) {
			case 'auto':
				root.tool_choice = 'auto';
				break;
			case 'none':
				root.tool_choice = 'none';
				break;
			case 'required':
				root.tool_choice = 'required';
				break;
			case 'specific':
				root.tool_choice = { type: 'function', function: { name: toolChoice.toolName } };
				break;
		}
	}

	return JSON.stringify(root);
}

/**
 * Parse a successful OpenAI Chat Completions response body into the unified
 * LlmResponse. Exposed at module scope for direct unit testing.
 */
export function parseOpenAiResponse(body: string): CompleteResult {
	let root: any;
	try {
		root = JSON.parse(body);
	} catch (json) {
		return { ok: false, error: { kind: 'parse', message: 'OpenAI returned malformed JSON' } };
	}

	const choices = root?.choices;
	const choice = Array.isArray(choices) ? choices[0] : undefined;
	if (!choice || typeof choice !== 'object') {
		return { ok: false, error: { kind: 'parse', message: 'OpenAI response did not contain choices' } };
	}
	const messageObj = choice.message;
	if (!messageObj || typeof messageObj !== 'object') {
		return { ok: false, error: { kind: 'parse', message: 'OpenAI choice did not contain a message' } };
	}

	const rawContent = messageObj.content;
	// OpenAI returns content as a string or null. Treat empty string as no text.
	const text: string | null = typeof rawContent === 'string' && rawContent.length > 0 ? rawContent : null;

	const toolCalls: LlmToolCall[] = [];
	const callsArray = messageObj.tool_calls;
	if (Array.isArray(callsArray)) {
		for (const call of callsArray) {
			if (!call || typeof call !== 'object') continue;
			const fn = call.function;
			if (!fn || typeof fn !== 'object') continue;
			const args = typeof fn.arguments === 'string' && fn.arguments.trim() !== '' ? fn.arguments : '{}';
			toolCalls.push({
				id: String(call.id ?? ''),
				name: String(fn.name ?? ''),
				argumentsJson: args,
			});
		}
	}

	const stopReason = mapStopReason(choice.finish_reason);

	const response: LlmResponse = { text, toolCalls, stopReason };
	return { ok: true, response };
}

function mapStopReason(finishReason: unknown): StopReason {
	switch (finishReason) {
		case 'stop':
			return 'end_turn';
		case 'tool_calls':
		case 'function_call':
			return 'tool_use';
		case 'length':
			return 'max_tokens';
		default:
			return 'other';
	}
}

function classifyHttpFailure(code: number, retryAfter: string | undefined, body: string): AssistantLlmError {
	const snippet = (body ?? '').slice(0, 200);
	if (code === 401 || code === 403) {
		return { kind: 'auth', message: `OpenAI rejected credentials (HTTP ${code}): ${snippet}` };
	}
	if (code === 429) {
		const retryAfterSeconds = retryAfter ? parseRetryAfter(retryAfter) : undefined;
		return { kind: 'rate_limited', message: `OpenAI rate limit hit (HTTP 429): ${snippet}`, retryAfterSeconds };
	}
	if (code >= 500 && code <= 599) {
		return { kind: 'server', message: `OpenAI server error (HTTP ${code}): ${snippet}`, statusCode: code };
	}
	return { kind: 'transport', message: `OpenAI returned unexpected HTTP ${code}: ${snippet}` };
}

function parseRetryAfter(value: string): number | undefined {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : undefined;
}

function trimTrailingSlash(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url;
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
 * Production LlmHttpTransport backed by node `https`/`http`. Mirrors the app's
 * OkHttp timeouts (connect 15s, call 60s, read 60s, write 30s); the call-level
 * timeout is enforced via the passed `timeoutMs`.
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
				req.destroy(new Error(`OpenAI request timed out after ${timeoutMs}ms`));
			});
			req.write(body);
			req.end();
		});
	},
};

/** Re-export for consumers. */
export type { LlmToolResult };
