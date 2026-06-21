/**
 * Multi-turn round-trip test for AnthropicLlmClient — the #1 risk mitigant
 * (Dispatch 3, piece A).
 *
 * Fakes the HTTP transport, runs a 3+ turn conversation that includes a tool
 * call + tool result, and asserts:
 *  (a) the OUTGOING wire JSON matches Anthropic /messages EXACTLY:
 *      - system prompt is a TOP-LEVEL `system` field (NOT a role:message);
 *      - assistant tool calls are `tool_use` content blocks;
 *      - the tool result is a USER message whose content is `tool_result`
 *        blocks keyed by `tool_use_id`;
 *      - `x-api-key` + `anthropic-version` headers (NOT Bearer).
 *  (b) the parsed LlmResponse (text/toolCalls/stopReason) is correct.
 *
 * A single field mismatch loses tool-result context or breaks the
 * system-prompt contract, so this test guards the wire-format port directly.
 * Mirrors the app's `AnthropicLlmClientTest.kt` + the D1 OpenAI round-trip
 * test structure.
 */

import { describe, it, expect } from 'vitest';
import {
	ANTHROPIC_VERSION,
	AnthropicLlmClient,
	anthropicMessagesUrl,
	buildAnthropicRequest,
	parseAnthropicResponse,
} from '../../../src/assistant/anthropic-llm-client';
import type { LlmHttpTransport } from '../../../src/assistant/assistant-llm-client';
import {
	LlmMessage,
	ToolSpec,
} from '../../../src/assistant/llm-types';

/** Build a fake transport that captures every outgoing request and replays canned responses. */
function fakeTransport(responses: { status: number; body: string }[]): {
	transport: LlmHttpTransport;
	requests: { url: string; headers: Record<string, string>; body: string }[];
} {
	const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
	let i = 0;
	const transport: LlmHttpTransport = {
		async post(url, headers, body) {
			requests.push({ url, headers, body });
			const canned = responses[Math.min(i, responses.length - 1)];
			i++;
			return {
				statusCode: canned.status,
				body: canned.body,
				headers: { 'content-type': 'application/json' },
			};
		},
	};
	return { transport, requests };
}

const WEATHER_TOOL: ToolSpec = {
	name: 'get_weather',
	description: 'Get the weather',
	parametersJsonSchema: '{"type":"object","properties":{"city":{"type":"string"}}}',
};

describe('AnthropicLlmClient — request wire format', () => {
	it('lifts system to a top-level field (NOT a role message), maps tools to input_schema, and Required->any', async () => {
		const { transport, requests } = fakeTransport([
			{ status: 200, body: '{"content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn"}' },
		]);
		const client = new AnthropicLlmClient(
			{ apiKey: 'anthropic-key', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
			transport,
		);

		const result = await client.complete(
			[LlmMessage.system('be terse'), LlmMessage.user('call the weather tool')],
			[WEATHER_TOOL],
			{ kind: 'required' },
		);

		expect(result.ok).toBe(true);
		expect(requests).toHaveLength(1);
		const req = requests[0];
		// URL: baseUrl + /messages.
		expect(req.url).toBe('https://api.anthropic.com/v1/messages');
		// Headers: x-api-key + anthropic-version (NOT Authorization: Bearer).
		expect(req.headers['x-api-key']).toBe('anthropic-key');
		expect(req.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
		expect(req.headers['Authorization']).toBeUndefined();
		expect(req.headers['Content-Type']).toBe('application/json; charset=utf-8');

		const body = JSON.parse(req.body);
		expect(body.model).toBe('claude-3-5-sonnet-latest');
		expect(body.max_tokens).toBe(4096);
		// System is a TOP-LEVEL field, NOT a message role.
		expect(body.system).toBe('be terse');
		const messages = body.messages;
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe('user');
		// No system role leaks into messages.
		expect(messages.find((m: { role: string }) => m.role === 'system')).toBeUndefined();
		// tools[] shape: name + description + input_schema.
		const tool = body.tools[0];
		expect(tool.name).toBe('get_weather');
		expect(tool.description).toBe('Get the weather');
		expect(tool.input_schema).toEqual({ type: 'object', properties: { city: { type: 'string' } } });
		// tool_choice: required -> {type:"any"} for Anthropic.
		expect(body.tool_choice).toEqual({ type: 'any' });
	});

	it('omits tools and tool_choice when no tools are supplied, and omits system when absent', async () => {
		const { transport, requests } = fakeTransport([
			{ status: 200, body: '{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}' },
		]);
		const client = new AnthropicLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
			transport,
		);

		await client.complete([LlmMessage.user('hi')]);

		const body = JSON.parse(requests[0].body);
		expect(body.system).toBeUndefined();
		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
	});

	it('emits assistant tool_use content blocks', () => {
		const body = JSON.parse(
			buildAnthropicRequest(
				[
					{
						role: 'assistant',
						text: 'Let me check.',
						toolCalls: [{ id: 'toolu_1', name: 'get_weather', argumentsJson: '{"city":"Paris"}' }],
					},
				],
				[],
				undefined,
				'claude-3-5-sonnet-latest',
				256,
			),
		);
		const assistant = body.messages[0];
		expect(assistant.role).toBe('assistant');
		expect(assistant.content).toHaveLength(2);
		// [0] text block
		expect(assistant.content[0].type).toBe('text');
		expect(assistant.content[0].text).toBe('Let me check.');
		// [1] tool_use block
		const toolUse = assistant.content[1];
		expect(toolUse.type).toBe('tool_use');
		expect(toolUse.id).toBe('toolu_1');
		expect(toolUse.name).toBe('get_weather');
		expect(toolUse.input).toEqual({ city: 'Paris' });
	});

	it('emits assistant tool_use with {} input when arguments are blank', () => {
		const body = JSON.parse(
			buildAnthropicRequest(
				[{ role: 'assistant', text: null, toolCalls: [{ id: 't1', name: 'f', argumentsJson: '' }] }],
				[],
				undefined,
				'm',
				1,
			),
		);
		expect(body.messages[0].content[0].type).toBe('tool_use');
		expect(body.messages[0].content[0].input).toEqual({});
	});

	it('maps tool_choice variants: auto->auto, none->none, required->any, specific->{type:tool,name}', () => {
		const cases: Array<{ choice: import('../../../src/assistant/llm-types').ToolChoice; expected: unknown }> = [
			{ choice: { kind: 'auto' }, expected: { type: 'auto' } },
			{ choice: { kind: 'none' }, expected: { type: 'none' } },
			{ choice: { kind: 'required' }, expected: { type: 'any' } },
			{ choice: { kind: 'specific', toolName: 'get_weather' }, expected: { type: 'tool', name: 'get_weather' } },
		];
		for (const { choice, expected } of cases) {
			const body = JSON.parse(buildAnthropicRequest([LlmMessage.user('hi')], [WEATHER_TOOL], choice, 'm', 1));
			expect(body.tool_choice).toEqual(expected);
		}
	});
});

describe('AnthropicLlmClient — response parsing', () => {
	it('parses tool_use blocks into unified LlmToolCall with tool_use stop reason', async () => {
		const { transport } = fakeTransport([
			{
				status: 200,
				body: JSON.stringify({
					content: [
						{ type: 'text', text: 'Let me check.' },
						{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
					],
					stop_reason: 'tool_use',
				}),
			},
		]);
		const client = new AnthropicLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
			transport,
		);

		const result = await client.complete([LlmMessage.user('weather?')]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.response.text).toBe('Let me check.');
		expect(result.response.stopReason).toBe('tool_use');
		expect(result.response.toolCalls).toHaveLength(1);
		const call = result.response.toolCalls[0];
		expect(call.id).toBe('toolu_1');
		expect(call.name).toBe('get_weather');
		expect(JSON.parse(call.argumentsJson).city).toBe('Paris');
	});

	it('maps stop_reason: end_turn/stop_sequence->end_turn, max_tokens->max_tokens, unknown->other', () => {
		const endTurn = parseAnthropicResponse('{"content":[{"type":"text","text":"x"}],"stop_reason":"end_turn"}');
		const stopSeq = parseAnthropicResponse('{"content":[{"type":"text","text":"x"}],"stop_reason":"stop_sequence"}');
		const maxTokens = parseAnthropicResponse('{"content":[{"type":"text","text":"x"}],"stop_reason":"max_tokens"}');
		const unknown = parseAnthropicResponse('{"content":[{"type":"text","text":"x"}],"stop_reason":"weird"}');
		expect(endTurn.ok && endTurn.response.stopReason).toBe('end_turn');
		expect(stopSeq.ok && stopSeq.response.stopReason).toBe('end_turn');
		expect(maxTokens.ok && maxTokens.response.stopReason).toBe('max_tokens');
		expect(unknown.ok && unknown.response.stopReason).toBe('other');
	});

	it('text-only response has empty toolCalls', () => {
		const r = parseAnthropicResponse('{"content":[{"type":"text","text":"plain"}],"stop_reason":"end_turn"}');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.response.text).toBe('plain');
		expect(r.response.toolCalls).toHaveLength(0);
		expect(r.response.stopReason).toBe('end_turn');
	});

	it('tool_use-only response has null text', () => {
		const r = parseAnthropicResponse('{"content":[{"type":"tool_use","id":"t1","name":"f","input":{}}],"stop_reason":"tool_use"}');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.response.text).toBeNull();
		expect(r.response.toolCalls).toHaveLength(1);
	});

	it('returns a parse error on malformed JSON or missing content array', () => {
		const malformed = parseAnthropicResponse('not json');
		expect(malformed.ok).toBe(false);
		if (!malformed.ok) expect(malformed.error.kind).toBe('parse');
		const noContent = parseAnthropicResponse('{}');
		expect(noContent.ok).toBe(false);
		if (!noContent.ok) expect(noContent.error.kind).toBe('parse');
	});
});

describe('AnthropicLlmClient — multi-turn round-trip (tool call + result)', () => {
	it('feeds tool results back as a USER message with tool_result content blocks keyed by tool_use_id', async () => {
		// The full 3-turn conversation:
		//   T1 system+user -> assistant(tool_use)
		//   T2 user + assistant(tool_use) + tool(result) -> assistant(text)
		const { transport, requests } = fakeTransport([
			{
				status: 200,
				body: JSON.stringify({
					content: [
						{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
					],
					stop_reason: 'tool_use',
				}),
			},
			{
				status: 200,
				body: JSON.stringify({
					content: [{ type: 'text', text: 'sunny, 21C' }],
					stop_reason: 'end_turn',
				}),
			},
		]);
		const client = new AnthropicLlmClient(
			{ apiKey: 'anthropic-key', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
			transport,
		);

		// T1: system + user -> assistant(tool_use)
		const t1 = await client.complete(
			[LlmMessage.system('be terse'), LlmMessage.user('weather in Paris?')],
			[WEATHER_TOOL],
		);
		expect(t1.ok).toBe(true);
		if (!t1.ok) return;
		expect(t1.response.toolCalls).toHaveLength(1);
		const call = t1.response.toolCalls[0];

		// T2: feed the assistant tool-use turn + the tool result back.
		const t2 = await client.complete([
			LlmMessage.system('be terse'),
			LlmMessage.user('weather in Paris?'),
			{ role: 'assistant', text: null, toolCalls: [call] },
			LlmMessage.toolResults([{ toolCallId: call.id, content: 'sunny, 21C' }]),
		]);
		expect(t2.ok).toBe(true);
		if (!t2.ok) return;
		expect(t2.response.text).toBe('sunny, 21C');

		// Assert the T2 OUTGOING wire JSON matches Anthropic EXACTLY.
		const body = JSON.parse(requests[1].body);
		// system is top-level, not in messages.
		expect(body.system).toBe('be terse');
		const messages = body.messages;
		// user, assistant(tool_use), user(tool_result) — system lifted out.
		expect(messages).toHaveLength(3);
		// [0] user
		expect(messages[0].role).toBe('user');
		expect(messages[0].content[0].type).toBe('text');
		expect(messages[0].content[0].text).toBe('weather in Paris?');
		// [1] assistant with tool_use content block
		const assistant = messages[1];
		expect(assistant.role).toBe('assistant');
		// Pure-tool turn: no text block, just the tool_use block.
		expect(assistant.content[0].type).toBe('tool_use');
		expect(assistant.content[0].id).toBe(call.id);
		expect(assistant.content[0].name).toBe('get_weather');
		expect(assistant.content[0].input).toEqual({ city: 'Paris' });
		// [2] USER message with tool_result content block (keyed by tool_use_id)
		const toolResultMsg = messages[2];
		expect(toolResultMsg.role).toBe('user');
		const resultBlock = toolResultMsg.content[0];
		expect(resultBlock.type).toBe('tool_result');
		expect(resultBlock.tool_use_id).toBe(call.id);
		expect(resultBlock.content).toBe('sunny, 21C');
		expect(resultBlock.is_error).toBe(false);
		// Headers confirmed on every call.
		expect(requests[1].headers['x-api-key']).toBe('anthropic-key');
		expect(requests[1].headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
	});

	it('marks tool_result is_error=true for an error result', () => {
		const body = JSON.parse(
			buildAnthropicRequest(
				[LlmMessage.toolResults([{ toolCallId: 't1', content: 'boom', isError: true }])],
				[],
				undefined,
				'm',
				1,
			),
		);
		const msg = body.messages[0];
		expect(msg.role).toBe('user');
		expect(msg.content[0].type).toBe('tool_result');
		expect(msg.content[0].is_error).toBe(true);
	});
});

describe('AnthropicLlmClient — base URL injection', () => {
	it('appends /messages to a standard Anthropic base URL', async () => {
		const { transport, requests } = fakeTransport([
			{ status: 200, body: '{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}' },
		]);
		const client = new AnthropicLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
			transport,
		);
		await client.complete([LlmMessage.user('hi')]);
		expect(requests[0].url).toBe('https://api.anthropic.com/v1/messages');
	});

	it('trims a trailing slash from the base URL', async () => {
		const { transport, requests } = fakeTransport([
			{ status: 200, body: '{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}' },
		]);
		const client = new AnthropicLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1/', model: 'claude-3-5-sonnet-latest' },
			transport,
		);
		await client.complete([LlmMessage.user('hi')]);
		expect(requests[0].url).toBe('https://api.anthropic.com/v1/messages');
	});

	it('ZAI base URL (no /v1) targets /v1/messages', async () => {
		const { transport, requests } = fakeTransport([
			{ status: 200, body: '{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}' },
		]);
		const client = new AnthropicLlmClient(
			{ apiKey: 'zai-key', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6' },
			transport,
		);
		await client.complete([LlmMessage.user('hi')]);
		expect(requests[0].url).toBe('https://api.z.ai/api/anthropic/v1/messages');
		expect(JSON.parse(requests[0].body).model).toBe('glm-4.6');
		expect(requests[0].headers['x-api-key']).toBe('zai-key');
	});
});

describe('anthropicMessagesUrl — ZAI root detection', () => {
	it('ZAI anthropic root (no /v1) appends /v1/messages', () => {
		expect(anthropicMessagesUrl('https://api.z.ai/api/anthropic')).toBe('https://api.z.ai/api/anthropic/v1/messages');
	});
	it('ZAI anthropic /v1 base appends /messages directly', () => {
		expect(anthropicMessagesUrl('https://api.z.ai/api/anthropic/v1')).toBe('https://api.z.ai/api/anthropic/v1/messages');
	});
	it('Anthropic base appends /messages directly', () => {
		expect(anthropicMessagesUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/messages');
	});
});

describe('AnthropicLlmClient — error classification', () => {
	it('401 -> auth error', async () => {
		const { transport } = fakeTransport([{ status: 401, body: '{"error":"bad key"}' }]);
		const client = new AnthropicLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
			transport,
		);
		const r = await client.complete([LlmMessage.user('hi')]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.kind).toBe('auth');
		expect(r.error.message).toContain('HTTP 401');
	});

	it('429 -> rate_limited with retryAfterSeconds from Retry-After header', async () => {
		const transport: LlmHttpTransport = {
			async post() {
				return { statusCode: 429, body: 'slow down', headers: { 'retry-after': '30' } };
			},
		};
		const client = new AnthropicLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
			transport,
		);
		const r = await client.complete([LlmMessage.user('hi')]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.kind).toBe('rate_limited');
		if (r.error.kind === 'rate_limited') expect(r.error.retryAfterSeconds).toBe(30);
	});

	it('503 -> server error with statusCode', async () => {
		const transport: LlmHttpTransport = {
			async post() {
				return { statusCode: 503, body: 'down', headers: {} };
			},
		};
		const client = new AnthropicLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
			transport,
		);
		const r = await client.complete([LlmMessage.user('hi')]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.kind).toBe('server');
		if (r.error.kind === 'server') expect(r.error.statusCode).toBe(503);
	});

	it('transport rejection -> transport error', async () => {
		const transport: LlmHttpTransport = {
			async post() {
				throw new Error('ECONNREFUSED');
			},
		};
		const client = new AnthropicLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
			transport,
		);
		const r = await client.complete([LlmMessage.user('hi')]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.kind).toBe('transport');
	});
});
