/**
 * Agent loop tests — scripts a fake AssistantLlmClient + fake AssistantActions
 * to exercise the dispatch paths end to end.
 *
 * Covers: text-only answer, single inspect tool call, mutating tool confirm,
 * mutating tool cancel, mutating tool correct (replan), CommandSafety rejection
 * of run_command (blocked before the gate), resolve_folder confident/ambiguous/
 * no-match, and the step cap.
 *
 * The loop owns no vscode / SSH / tmux types, so these tests run without the
 * extension host.
 */

import { describe, it, expect, vi } from 'vitest';
import { AssistantAgentLoop } from '../../../src/assistant/assistant-agent-loop';
import type { Outcome, ConfirmGate, ChoiceGate } from '../../../src/assistant/assistant-agent-loop';
import type { AssistantLlmClient } from '../../../src/assistant/assistant-llm-client';
import type { AssistantActions, FolderResolutionResult } from '../../../src/assistant/assistant-actions';
import { ActionResult } from '../../../src/assistant/assistant-actions';
import type {
	CompleteResult,
	LlmResponse,
	LlmMessage,
} from '../../../src/assistant/llm-types';

/** Build a fake AssistantLlmClient that replays a scripted list of responses. */
function fakeClient(responses: CompleteResult[]): AssistantLlmClient & { calls: LlmMessage[][] } {
	const calls: LlmMessage[][] = [];
	let i = 0;
	return {
		calls,
		async complete(messages: readonly LlmMessage[]): Promise<CompleteResult> {
			calls.push([...messages]);
			const r = responses[Math.min(i, responses.length - 1)];
			i++;
			return r;
		},
	};
}

function textResponse(text: string): CompleteResult {
	const response: LlmResponse = { text, toolCalls: [], stopReason: 'end_turn' };
	return { ok: true, response };
}

function toolCallResponse(calls: { id: string; name: string; args: string }[], text: string | null = null): CompleteResult {
	const response: LlmResponse = {
		text,
		toolCalls: calls.map((c) => ({ id: c.id, name: c.name, argumentsJson: c.args })),
		stopReason: 'tool_use',
	};
	return { ok: true, response };
}

/** A minimal fake AssistantActions with vi.fn spies + default safe returns. */
function fakeActions(overrides: Partial<AssistantActions> = {}): AssistantActions {
	const defaults: AssistantActions = {
		getContext: async () => 'no context',
		listHosts: async () => 'no hosts',
		listFolders: async (_h: string) => 'no folders',
		resolveFolder: async (_h: string, _q: string): Promise<FolderResolutionResult> => ({
			kind: 'unavailable',
			message: 'unavailable',
		}),
		listSessions: async (_h: string) => 'no sessions',
		listDirectory: async (_p: string) => 'empty',
		readFile: async (_p: string) => '',
		listRepos: async () => 'no repos',
		openFolder: async (_h: string, _p: string) => 'ok',
		openSession: async (_s: string) => 'ok',
		openScreen: async (_d: string) => 'ok',
		startSession: async (_h: string, _c: string, _a: string) => ActionResult.ok('started'),
		sendPromptToSession: async (_s: string, _p: string) => ActionResult.ok('sent'),
		createProject: async (_h: string, _p: string, _f: string) => ActionResult.ok('created'),
		runCommand: async (_c: string) => ActionResult.ok('ran'),
		createFile: async (_p: string, _c: string) => ActionResult.ok('created'),
		cloneRepo: async (_f: string, _o: string | null) => ActionResult.ok('cloned'),
	};
	return { ...defaults, ...overrides } as AssistantActions;
}

describe('AssistantAgentLoop — text-only answer', () => {
	it('returns the model text as an Answer outcome', async () => {
		const client = fakeClient([textResponse('All good.')]);
		const loop = new AssistantAgentLoop({ client, actions: fakeActions() });
		const outcome = await loop.run('hi', { confirmGate: async () => ({ kind: 'cancel' }) });
		expect(outcome.kind).toBe('answer');
		expect((outcome as { text: string }).text).toBe('All good.');
	});

	it('returns "Done." when the model answers with empty text', async () => {
		const client = fakeClient([textResponse('')]);
		const loop = new AssistantAgentLoop({ client, actions: fakeActions() });
		const outcome = await loop.run('hi', { confirmGate: async () => ({ kind: 'cancel' }) });
		expect(outcome.kind).toBe('answer');
		expect((outcome as { text: string }).text).toBe('Done.');
	});
});

describe('AssistantAgentLoop — inspect tool dispatch', () => {
	it('runs an inspect tool, feeds the result back, then answers', async () => {
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'list_hosts', args: '{}' }]),
			textResponse('I listed the hosts.'),
		]);
		const listHosts = vi.fn(async () => 'host-a\nhost-b');
		const actions = fakeActions({ listHosts });
		const loop = new AssistantAgentLoop({ client, actions });

		const outcome = await loop.run('what hosts?', { confirmGate: async () => ({ kind: 'cancel' }) });

		expect(outcome.kind).toBe('answer');
		expect(listHosts).toHaveBeenCalledOnce();
		// The second model call should include the tool result message.
		const secondCallMessages = client.calls[1];
		const toolResultMsg = secondCallMessages.find((m) => m.role === 'tool');
		expect(toolResultMsg).toBeDefined();
		expect(toolResultMsg?.toolResults?.[0].content).toBe('host-a\nhost-b');
	});

	it('run_command (inspect-like nav with NO args) returns "Unknown tool" for unrecognised names', async () => {
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'not_a_real_tool', args: '{}' }]),
			textResponse('ok'),
		]);
		const loop = new AssistantAgentLoop({ client, actions: fakeActions() });
		await loop.run('x', { confirmGate: async () => ({ kind: 'cancel' }) });
		// The unknown-tool result is relayed to the model on the next turn.
		const toolResultMsg = client.calls[1].find((m) => m.role === 'tool');
		expect(toolResultMsg?.toolResults?.[0].content).toContain('Unknown tool');
	});
});

describe('AssistantAgentLoop — mutating tool confirm gate', () => {
	it('Confirm -> executes the mutating action', async () => {
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'create_file', args: JSON.stringify({ path: '/tmp/x', content: 'hi' }) }]),
			textResponse('Created it.'),
		]);
		const createFile = vi.fn(async () => ActionResult.ok('created /tmp/x'));
		const actions = fakeActions({ createFile });
		const confirmGate: ConfirmGate = async () => ({ kind: 'confirm' });
		const loop = new AssistantAgentLoop({ client, actions });

		const outcome = await loop.run('make a file', { confirmGate });

		expect(outcome.kind).toBe('answer');
		expect(createFile).toHaveBeenCalledOnce();
		expect(createFile).toHaveBeenCalledWith('/tmp/x', 'hi');
	});

	it('Cancel -> returns a Cancelled outcome and does NOT execute', async () => {
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'create_file', args: JSON.stringify({ path: '/tmp/x', content: 'hi' }) }]),
		]);
		const createFile = vi.fn(async () => ActionResult.ok('ok'));
		const actions = fakeActions({ createFile });
		const confirmGate: ConfirmGate = async () => ({ kind: 'cancel' });
		const loop = new AssistantAgentLoop({ client, actions });

		const outcome = await loop.run('make a file', { confirmGate });

		expect(outcome.kind).toBe('cancelled');
		expect(createFile).not.toHaveBeenCalled();
	});

	it('Correct -> relays the correction + replans (skips remaining batched calls)', async () => {
		const client = fakeClient([
			// Two tool calls in one turn; the first is mutating and corrected.
			toolCallResponse([
				{ id: 'c1', name: 'create_file', args: JSON.stringify({ path: '/a', content: 'x' }) },
				{ id: 'c2', name: 'create_file', args: JSON.stringify({ path: '/b', content: 'y' }) },
			]),
			// Next turn: the model answers after replanning.
			textResponse('Revised.'),
		]);
		const createFile = vi.fn(async () => ActionResult.ok('ok'));
		const actions = fakeActions({ createFile });
		const confirmGate: ConfirmGate = async () => ({ kind: 'correct', correction: 'use /c instead' });
		const loop = new AssistantAgentLoop({ client, actions });

		const outcome = await loop.run('make files', { confirmGate });

		expect(outcome.kind).toBe('answer');
		// Neither mutating call executed; the correction was relayed.
		expect(createFile).not.toHaveBeenCalled();
		// The skipped c2 gets a "Not executed" result.
		const toolResults = client.calls[1].find((m) => m.role === 'tool')?.toolResults ?? [];
		const c2Result = toolResults.find((r) => r.toolCallId === 'c2');
		expect(c2Result?.isError).toBe(true);
		expect(c2Result?.content).toContain('Not executed');
	});
});

describe('AssistantAgentLoop — CommandSafety gate on run_command', () => {
	it('rejects a blocked run_command BEFORE the confirm gate (relay to model)', async () => {
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'run_command', args: JSON.stringify({ command: 'sudo rm -rf /' }) }]),
			textResponse('I cannot run that.'),
		]);
		const runCommand = vi.fn(async () => ActionResult.ok('ran'));
		const actions = fakeActions({ runCommand });
		const confirmGate = vi.fn(async () => ({ kind: 'confirm' }) as const);
		const loop = new AssistantAgentLoop({ client, actions });

		await loop.run('nuke it', { confirmGate });

		// Safety blocked it before the gate was offered.
		expect(confirmGate).not.toHaveBeenCalled();
		expect(runCommand).not.toHaveBeenCalled();
		const toolResult = client.calls[1].find((m) => m.role === 'tool')?.toolResults?.[0];
		expect(toolResult?.isError).toBe(true);
		expect(toolResult?.content).toContain('safety rule');
	});

	it('passes a safe run_command through to the confirm gate', async () => {
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'run_command', args: JSON.stringify({ command: 'ls -la' }) }]),
			textResponse('done'),
		]);
		const confirmGate = vi.fn(async () => ({ kind: 'confirm' }) as const);
		const loop = new AssistantAgentLoop({ client, actions: fakeActions() });
		await loop.run('list', { confirmGate });
		expect(confirmGate).toHaveBeenCalledOnce();
	});
});

describe('AssistantAgentLoop — resolve_folder bespoke dispatch', () => {
	it('confident -> relays the cwd straight to the model', async () => {
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'resolve_folder', args: JSON.stringify({ host: 'prod', query: 'rov workshop' }) }]),
			textResponse('ok'),
		]);
		const actions = fakeActions({
			resolveFolder: async () => ({
				kind: 'resolved' as const,
				resolution: { kind: 'confident' as const, candidate: { path: '/p/rov', label: 'ROV' } },
			}),
		});
		const loop = new AssistantAgentLoop({ client, actions });
		await loop.run('open rov', { confirmGate: async () => ({ kind: 'cancel' }) });
		const result = client.calls[1].find((m) => m.role === 'tool')?.toolResults?.[0];
		expect(result?.content).toContain('Confident match');
		expect(result?.content).toContain('/p/rov');
	});

	it('ambiguous + pick -> relays the chosen cwd', async () => {
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'resolve_folder', args: JSON.stringify({ host: 'prod', query: 'workshop' }) }]),
			textResponse('ok'),
		]);
		const actions = fakeActions({
			resolveFolder: async () => ({
				kind: 'resolved' as const,
				resolution: {
					kind: 'ambiguous' as const,
					candidates: [
						{ path: '/a', label: 'A' },
						{ path: '/b', label: 'B' },
					],
				},
			}),
		});
		const choiceGate: ChoiceGate = async (_q, cands) => ({ kind: 'pick', candidate: cands[1] });
		const loop = new AssistantAgentLoop({ client, actions });
		await loop.run('open workshop', { confirmGate: async () => ({ kind: 'cancel' }), choiceGate });
		const result = client.calls[1].find((m) => m.role === 'tool')?.toolResults?.[0];
		expect(result?.content).toContain('The user chose B at /b');
	});

	it('ambiguous + cancel -> Cancelled outcome', async () => {
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'resolve_folder', args: JSON.stringify({ host: 'prod', query: 'workshop' }) }]),
		]);
		const actions = fakeActions({
			resolveFolder: async () => ({
				kind: 'resolved' as const,
				resolution: { kind: 'ambiguous' as const, candidates: [{ path: '/a', label: 'A' }] },
			}),
		});
		const loop = new AssistantAgentLoop({ client, actions });
		const outcome = await loop.run('open workshop', {
			confirmGate: async () => ({ kind: 'cancel' }),
			choiceGate: async () => ({ kind: 'cancel' }),
		});
		expect(outcome.kind).toBe('cancelled');
	});

	it('no_match -> relays "No folder matched" + nearest', async () => {
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'resolve_folder', args: JSON.stringify({ host: 'prod', query: 'zzz' }) }]),
			textResponse('ok'),
		]);
		const actions = fakeActions({
			resolveFolder: async () => ({
				kind: 'resolved' as const,
				resolution: {
					kind: 'no_match' as const,
					nearest: [{ path: '/a', label: 'A' }],
				},
			}),
		});
		const loop = new AssistantAgentLoop({ client, actions });
		await loop.run('open zzz', { confirmGate: async () => ({ kind: 'cancel' }) });
		const result = client.calls[1].find((m) => m.role === 'tool')?.toolResults?.[0];
		expect(result?.content).toContain('No folder matched');
		expect(result?.content).toContain('A (/a)');
	});

	it('unavailable -> relays the unavailable message', async () => {
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'resolve_folder', args: JSON.stringify({ host: 'x', query: 'y' }) }]),
			textResponse('ok'),
		]);
		const actions = fakeActions({
			resolveFolder: async () => ({ kind: 'unavailable', message: 'Host x unknown.' }),
		});
		const loop = new AssistantAgentLoop({ client, actions });
		await loop.run('resolve', { confirmGate: async () => ({ kind: 'cancel' }) });
		const result = client.calls[1].find((m) => m.role === 'tool')?.toolResults?.[0];
		expect(result?.content).toBe('Host x unknown.');
	});
});

describe('AssistantAgentLoop — error + step-cap paths', () => {
	it('transport error -> retryable_error outcome', async () => {
		const client = fakeClient([{ ok: false, error: { kind: 'transport', message: 'ECONNREFUSED' } }]);
		const loop = new AssistantAgentLoop({ client, actions: fakeActions() });
		const outcome = await loop.run('hi', { confirmGate: async () => ({ kind: 'cancel' }) });
		expect(outcome.kind).toBe('retryable_error');
	});

	it('auth error -> failed (non-retryable) outcome', async () => {
		const client = fakeClient([{ ok: false, error: { kind: 'auth', message: 'bad key' } }]);
		const loop = new AssistantAgentLoop({ client, actions: fakeActions() });
		const outcome = await loop.run('hi', { confirmGate: async () => ({ kind: 'cancel' }) });
		expect(outcome.kind).toBe('failed');
	});

	it('step cap -> failed outcome', async () => {
		// The model always requests a tool call; the loop hits maxSteps=2.
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'list_hosts', args: '{}' }]),
			toolCallResponse([{ id: 'c2', name: 'list_hosts', args: '{}' }]),
			toolCallResponse([{ id: 'c3', name: 'list_hosts', args: '{}' }]),
		]);
		const loop = new AssistantAgentLoop({ client, actions: fakeActions(), maxSteps: 2 });
		const outcome = await loop.run('loop', { confirmGate: async () => ({ kind: 'cancel' }) });
		expect(outcome.kind).toBe('failed');
		expect((outcome as { message: string }).message).toContain('step limit');
	});
});

describe('AssistantAgentLoop — mutating tools stubbed path (Dispatch 1 contract)', () => {
	// In Dispatch 1 the desktop actions stub the 6 mutating methods to return
	// an error ActionResult. The loop relays the error message verbatim. This
	// test documents that contract so Dispatch 2 knows what it replaces.
	it('mutating action error is relayed to the model as an error tool result', async () => {
		const client = fakeClient([
			toolCallResponse([{ id: 'c1', name: 'start_session', args: JSON.stringify({ host: 'h', cwd: '/c', agent: 'codex' }) }]),
			textResponse('ok'),
		]);
		const actions = fakeActions({
			startSession: async () => ActionResult.error('Mutating actions are enabled in a follow-up update.'),
		});
		const loop = new AssistantAgentLoop({ client, actions });
		await loop.run('start', { confirmGate: async () => ({ kind: 'confirm' }) });
		const result = client.calls[1].find((m) => m.role === 'tool')?.toolResults?.[0];
		expect(result?.isError).toBe(true);
		expect(result?.content).toContain('follow-up update');
	});
});
