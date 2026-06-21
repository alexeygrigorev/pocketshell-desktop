/**
 * Multi-turn round-trip test for OpenAiLlmClient — the #1 risk mitigant.
 *
 * Fakes the HTTP transport, runs a 3+ turn conversation that includes a tool
 * call + tool result, and asserts:
 *  (a) the OUTGOING wire JSON matches OpenAI chat-completions EXACTLY (system
 *      as a role message, tool_calls on the assistant message, role:"tool"
 *      result messages with matching tool_call_id).
 *  (b) the parsed LlmResponse (text/toolCalls/stopReason) is correct.
 *
 * A single field mismatch loses tool-result context, so this test guards the
 * wire-format port directly. Mirrors the app's `OpenAiLlmClientTest.kt`.
 */

import { describe, it, expect } from 'vitest';
import {
	OpenAiLlmClient,
	buildOpenAiRequest,
	parseOpenAiResponse,
} from '../../../src/assistant/openai-llm-client';
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

describe('OpenAiLlmClient — request wire format', () => {
	it('includes system as a role message, tools, and tool_choice', async () => {
		const { transport, requests } = fakeTransport([
			{ status: 200, body: '{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}' },
		]);
		const client = new OpenAiLlmClient(
			{ apiKey: 'openai-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
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
		// URL: baseUrl + /chat/completions, no trailing-slash duplication.
		expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
		// Authorization: Bearer <key> — never logged elsewhere.
		expect(req.headers['Authorization']).toBe('Bearer openai-key');
		expect(req.headers['Content-Type']).toBe('application/json; charset=utf-8');

		const body = JSON.parse(req.body);
		expect(body.model).toBe('gpt-4o');
		expect(body.max_tokens).toBe(4096);
		const messages = body.messages;
		expect(messages[0].role).toBe('system');
		expect(messages[0].content).toBe('be terse');
		expect(messages[1].role).toBe('user');
		expect(messages[1].content).toBe('call the weather tool');
		// tools[] shape: type:function, function.name + parameters.
		const tool = body.tools[0];
		expect(tool.type).toBe('function');
		expect(tool.function.name).toBe('get_weather');
		expect(tool.function.parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } } });
		// tool_choice: required.
		expect(body.tool_choice).toBe('required');
	});

	it('omits tools and tool_choice when no tools are supplied', async () => {
		const { transport, requests } = fakeTransport([
			{ status: 200, body: '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}' },
		]);
		const client = new OpenAiLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
			transport,
		);

		await client.complete([LlmMessage.user('hi')]);

		const body = JSON.parse(requests[0].body);
		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
	});

	it('sends assistant tool_calls on the assistant message (null content for pure-tool turn)', () => {
		const body = JSON.parse(
			buildOpenAiRequest(
				[
					{
						role: 'assistant',
						text: null,
						toolCalls: [{ id: 'call_1', name: 'f', argumentsJson: '{}' }],
					},
				],
				[],
				undefined,
				'gpt-4o',
				256,
			),
		);
		const assistant = body.messages[0];
		expect(assistant.role).toBe('assistant');
		// OpenAI requires content present; null for a pure-tool turn.
		expect(assistant.content).toBeNull();
		const toolCall = assistant.tool_calls[0];
		expect(toolCall.id).toBe('call_1');
		expect(toolCall.type).toBe('function');
		expect(toolCall.function.name).toBe('f');
		expect(toolCall.function.arguments).toBe('{}');
	});

	it('defaults blank arguments to {}', () => {
		const body = JSON.parse(
			buildOpenAiRequest(
				[{ role: 'assistant', text: null, toolCalls: [{ id: 'c1', name: 'f', argumentsJson: '' }] }],
				[],
				undefined,
				'm',
				1,
			),
		);
		expect(body.messages[0].tool_calls[0].function.arguments).toBe('{}');
	});
});

describe('OpenAiLlmClient — response parsing', () => {
	it('parses tool_calls into unified LlmToolCall with tool_use stop reason', async () => {
		const { transport } = fakeTransport([
			{
				status: 200,
				body: JSON.stringify({
					choices: [
						{
							message: {
								content: null,
								tool_calls: [
									{
										id: 'call_1',
										type: 'function',
										function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
									},
								],
							},
							finish_reason: 'tool_calls',
						},
					],
				}),
			},
		]);
		const client = new OpenAiLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
			transport,
		);

		const result = await client.complete([LlmMessage.user('weather?')]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.response.text).toBeNull();
		expect(result.response.stopReason).toBe('tool_use');
		const call = result.response.toolCalls[0];
		expect(call.id).toBe('call_1');
		expect(call.name).toBe('get_weather');
		expect(JSON.parse(call.argumentsJson).city).toBe('Paris');
	});

	it('maps finish_reason stop -> end_turn, length -> max_tokens, unknown -> other', () => {
		const stop = parseOpenAiResponse('{"choices":[{"message":{"content":"x"},"finish_reason":"stop"}]}');
		const length = parseOpenAiResponse('{"choices":[{"message":{"content":"x"},"finish_reason":"length"}]}');
		const unknown = parseOpenAiResponse('{"choices":[{"message":{"content":"x"},"finish_reason":"content_filter"}]}');
		expect(stop.ok && stop.response.stopReason).toBe('end_turn');
		expect(length.ok && length.response.stopReason).toBe('max_tokens');
		expect(unknown.ok && unknown.response.stopReason).toBe('other');
	});

	it('treats empty content string as null text', () => {
		const r = parseOpenAiResponse('{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}');
		expect(r.ok && r.response.text).toBeNull();
	});

	it('returns a parse error on malformed JSON or missing choices', () => {
		const malformed = parseOpenAiResponse('not json');
		expect(malformed.ok).toBe(false);
		if (!malformed.ok) expect(malformed.error.kind).toBe('parse');
		const noChoices = parseOpenAiResponse('{}');
		expect(noChoices.ok).toBe(false);
	});
});

describe('OpenAiLlmClient — multi-turn round-trip (tool call + result)', () => {
	it('feeds tool results back as role:tool messages keyed by tool_call_id', async () => {
		// The full 3-turn conversation:
		//   T1 user -> assistant(tool_call)
		//   T2 user + assistant(tool_call) + tool(result) -> assistant(text)
		const { transport, requests } = fakeTransport([
			{
				status: 200,
				body: JSON.stringify({
					choices: [
						{
							message: {
								content: null,
								tool_calls: [
									{
										id: 'call_1',
										type: 'function',
										function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
									},
								],
							},
							finish_reason: 'tool_calls',
						},
					],
				}),
			},
			{
				status: 200,
				body: JSON.stringify({
					choices: [
						{ message: { content: 'sunny, 21C' }, finish_reason: 'stop' },
					],
				}),
			},
		]);
		const client = new OpenAiLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
			transport,
		);

		// T1: user -> assistant(tool_call)
		const t1 = await client.complete([LlmMessage.user('weather?')], [WEATHER_TOOL]);
		expect(t1.ok).toBe(true);
		if (!t1.ok) return;
		expect(t1.response.toolCalls).toHaveLength(1);
		const call = t1.response.toolCalls[0];

		// T2: feed the assistant tool-call turn + the tool result back.
		const t2 = await client.complete([
			LlmMessage.user('weather?'),
			{ role: 'assistant', text: null, toolCalls: [call] },
			LlmMessage.toolResults([{ toolCallId: call.id, content: 'sunny, 21C' }]),
		]);
		expect(t2.ok).toBe(true);
		if (!t2.ok) return;
		expect(t2.response.text).toBe('sunny, 21C');

		// Assert the T2 OUTGOING wire JSON matches OpenAI EXACTLY.
		const body = JSON.parse(requests[1].body);
		const messages = body.messages;
		expect(messages).toHaveLength(3);
		// [0] user
		expect(messages[0].role).toBe('user');
		expect(messages[0].content).toBe('weather?');
		// [1] assistant with tool_calls
		const assistant = messages[1];
		expect(assistant.role).toBe('assistant');
		expect(assistant.content).toBeNull();
		const wireCall = assistant.tool_calls[0];
		expect(wireCall.id).toBe(call.id);
		expect(wireCall.type).toBe('function');
		expect(wireCall.function.name).toBe('get_weather');
		expect(wireCall.function.arguments).toBe('{"city":"Paris"}');
		// [2] role:tool message keyed by tool_call_id
		const toolMsg = messages[2];
		expect(toolMsg.role).toBe('tool');
		expect(toolMsg.tool_call_id).toBe(call.id);
		expect(toolMsg.content).toBe('sunny, 21C');
	});

	it('base URL injection targets a custom gateway (path preserved)', async () => {
		const { transport, requests } = fakeTransport([
			{ status: 200, body: '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}' },
		]);
		const client = new OpenAiLlmClient(
			{ apiKey: 'k', baseUrl: 'https://gw.example/gateway/openai', model: 'gpt-4o-mini' },
			transport,
		);
		await client.complete([LlmMessage.user('hi')]);
		expect(requests[0].url).toBe('https://gw.example/gateway/openai/chat/completions');
		expect(JSON.parse(requests[0].body).model).toBe('gpt-4o-mini');
	});

	it('trims a trailing slash from the base URL', async () => {
		const { transport, requests } = fakeTransport([
			{ status: 200, body: '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}' },
		]);
		const client = new OpenAiLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.openai.com/v1/', model: 'gpt-4o' },
			transport,
		);
		await client.complete([LlmMessage.user('hi')]);
		expect(requests[0].url).toBe('https://api.openai.com/v1/chat/completions');
	});
});

describe('OpenAiLlmClient — error classification', () => {
	it('401 -> auth error', async () => {
		const { transport } = fakeTransport([{ status: 401, body: 'bad key' }]);
		const client = new OpenAiLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
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
		const client = new OpenAiLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
			transport,
		);
		const r = await client.complete([LlmMessage.user('hi')]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.kind).toBe('rate_limited');
		expect(r.error.retryAfterSeconds).toBe(30);
	});

	it('500 -> server error with statusCode', async () => {
		const transport: LlmHttpTransport = {
			async post() {
				return { statusCode: 503, body: 'down', headers: {} };
			},
		};
		const client = new OpenAiLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
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
		const client = new OpenAiLlmClient(
			{ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
			transport,
		);
		const r = await client.complete([LlmMessage.user('hi')]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.kind).toBe('transport');
	});
});

describe('OpenAiLlmClient — tool_choice variants', () => {
	const cases: Array<{ choice: import('../../../src/assistant/llm-types').ToolChoice; expected: unknown }> = [
		{ choice: { kind: 'auto' }, expected: 'auto' },
		{ choice: { kind: 'none' }, expected: 'none' },
		{ choice: { kind: 'required' }, expected: 'required' },
		{ choice: { kind: 'specific', toolName: 'get_weather' }, expected: { type: 'function', function: { name: 'get_weather' } } },
	];
	for (const { choice, expected } of cases) {
		it(`maps ${JSON.stringify(choice)} correctly`, () => {
			const body = JSON.parse(buildOpenAiRequest([LlmMessage.user('hi')], [WEATHER_TOOL], choice, 'm', 1));
			expect(body.tool_choice).toEqual(expected);
		});
	}
});
