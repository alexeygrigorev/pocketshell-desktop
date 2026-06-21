/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AssistantLlmClient } from './assistant-llm-client';
import type { AssistantActions } from './assistant-actions';
import { ActionResult } from './assistant-actions';
import {
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
	OPEN_FOLDER,
	OPEN_SCREEN,
	OPEN_SESSION,
	READ_FILE,
	RESOLVE_FOLDER,
	MUTATING_TOOLS,
	RUN_COMMAND,
	SEND_PROMPT_TO_SESSION,
	START_SESSION,
	SYSTEM_PROMPT,
} from './assistant-tools';
import { rejectCommand } from './command-safety';
import type { FolderCandidate } from './folder-resolver';
import type { AssistantTraceSink, AssistantTraceEvent } from './assistant-trace';
import { REDACTED } from './assistant-trace';
import {
	LlmMessage,
} from './llm-types';
import type {
	AssistantLlmError,
	CompleteResult,
	LlmToolCall,
	LlmToolResult,
	ToolSpec,
} from './llm-types';

/**
 * The provider-agnostic agent loop for the in-app action assistant.
 *
 * Ported from the Android app's `AssistantAgentLoop.kt`. Given a transcript,
 * it drives a multi-turn tool-calling conversation over an AssistantLlmClient:
 *
 *  1. Seed the conversation with a system prompt + the user transcript.
 *  2. Call the model with the full ASSISTANT_TOOLS catalog.
 *  3. For each tool call the model makes:
 *     - Inspect / navigation tools auto-run via AssistantActions.
 *     - `resolve_folder` suspends on a ChoiceGate if ambiguous.
 *     - MUTATING tools run the CommandSafety gate (for `run_command`) then
 *       suspend on the confirm-or-correct ConfirmGate.
 *         * Confirm  -> execute the candidate as-is.
 *         * Correct  -> the user's correction text is fed back into the loop
 *           as additional context; the model produces a revised candidate and
 *           we re-prompt. Loops until confirmed or cancelled.
 *  4. Feed every tool result back and iterate until the model returns a final
 *     text answer or the step cap is hit.
 *
 * The loop owns no vscode / SSH / tmux types — it talks to AssistantActions
 * (action seam), AssistantTraceSink (logging seam), ConfirmGate / ChoiceGate
 * (UX seams) — so it is fully unit-testable with a fake AssistantLlmClient
 * scripting tool calls, including a reject -> correct -> confirm sequence.
 *
 * Kept pure / vscode-free so the mirror is byte-identical (lesson #19).
 */

/** The user's response to a confirm-or-correct prompt for a mutating tool. */
export type Decision =
	| { kind: 'confirm' }
	| { kind: 'correct'; correction: string }
	| { kind: 'cancel' };

/** A candidate mutating action awaiting the user's decision. */
export interface Candidate {
	readonly toolName: string;
	/** Human-readable one-line summary, e.g. the exact command or path. */
	readonly summary: string;
}

/**
 * The user's response to a folder-disambiguation prompt: either they picked
 * one of the offered folders, or they backed out.
 */
export type ChoiceDecision =
	| { kind: 'pick'; candidate: FolderCandidate }
	| { kind: 'cancel' };

/** Final loop outcome surfaced to the UI. */
export type Outcome =
	| { kind: 'answer'; text: string }
	| { kind: 'cancelled'; text: string }
	| { kind: 'failed'; message: string }
	| { kind: 'retryable_error'; reason: AssistantLlmError; message: string };

/**
 * The confirm-or-correct UX seam. Given a Candidate, return the user's
 * Decision. The desktop impl surfaces the candidate, asks "Is this what you
 * want me to execute?", and resumes with Confirm / Correct / Cancel. In tests
 * this is a scripted function.
 */
export type ConfirmGate = (candidate: Candidate) => Promise<Decision>;

/**
 * The "which folder?" UX seam, sibling to ConfirmGate. Given the fuzzy `query`
 * and the ambiguous `candidates`, surface a chooser and return the user's
 * ChoiceDecision. The picked cwd is relayed straight back to the model with no
 * extra round-trip, so the model cannot re-guess the wrong folder.
 */
export type ChoiceGate = (query: string, candidates: readonly FolderCandidate[]) => Promise<ChoiceDecision>;

export interface AgentLoopOptions {
	readonly client: AssistantLlmClient;
	readonly actions: AssistantActions;
	readonly traceSink?: AssistantTraceSink;
	readonly installId?: string;
	readonly sessionId?: string | null;
	readonly maxSteps?: number;
	/** Per-model-call timeout (ms); a hung provider must fail instead of hanging forever. */
	readonly modelTurnTimeoutMs?: number;
}

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MODEL_TURN_TIMEOUT_MS = 60_000;

export class AssistantAgentLoop {
	private readonly client: AssistantLlmClient;
	private readonly actions: AssistantActions;
	private readonly traceSink: AssistantTraceSink;
	private readonly installId: string;
	private readonly sessionId: string | null;
	private readonly maxSteps: number;
	private readonly modelTurnTimeoutMs: number;

	constructor(opts: AgentLoopOptions) {
		this.client = opts.client;
		this.actions = opts.actions;
		this.traceSink = opts.traceSink ?? noopTraceSink;
		this.installId = opts.installId ?? 'unknown';
		this.sessionId = opts.sessionId ?? null;
		this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
		this.modelTurnTimeoutMs = opts.modelTurnTimeoutMs ?? DEFAULT_MODEL_TURN_TIMEOUT_MS;
	}

	async run(
		transcript: string,
		gates: {
			confirmGate: ConfirmGate;
			/** Defaults to always-cancel (Dispatch 1 doesn't need the chooser for read-only). */
			choiceGate?: ChoiceGate;
		},
	): Promise<Outcome> {
		const choiceGate: ChoiceGate = gates.choiceGate ?? ((_q, _c) => Promise.resolve({ kind: 'cancel' }));
		const messages: LlmMessage[] = [
			LlmMessage.system(SYSTEM_PROMPT),
			LlmMessage.user(transcript),
		];

		let step = 0;
		while (step < this.maxSteps) {
			step++;
			const turnResult = await this.runModelTurn(messages, ASSISTANT_TOOLS);
			if (!turnResult.ok) {
				return this.toErrorOutcome(turnResult.error);
			}
			const response = turnResult.response;

			if (response.toolCalls.length === 0) {
				const text = (response.text ?? '').trim();
				switch (response.stopReason) {
					case 'end_turn':
					case 'other':
						return { kind: 'answer', text: text.length > 0 ? text : 'Done.' };
					case 'max_tokens':
						return { kind: 'answer', text: text.length > 0 ? text : '(response truncated)' };
					case 'tool_use':
						// Provider said tool_use but gave no calls — treat as done.
						return { kind: 'answer', text: text.length > 0 ? text : 'Done.' };
				}
			}

			// Record the assistant's tool-call turn verbatim so the provider can
			// pair each result to its call id on the next request.
			messages.push({
				role: 'assistant',
				text: response.text,
				toolCalls: response.toolCalls,
			});

			const results: LlmToolResult[] = [];
			let corrected = false;
			for (let index = 0; index < response.toolCalls.length; index++) {
				const call = response.toolCalls[index];
				const outcome = await this.dispatch(call, gates.confirmGate, choiceGate);
				if (outcome.kind === 'cancel_loop') {
					return { kind: 'cancelled', text: outcome.message };
				}
				results.push(outcome.toolResult);
				if (outcome.replan) {
					corrected = true;
					// Skip the remaining calls in this batch, relaying a "not
					// executed" result for each so the provider sees all ids.
					for (let j = index + 1; j < response.toolCalls.length; j++) {
						const skipped = response.toolCalls[j];
						results.push({
							toolCallId: skipped.id,
							content:
								'Not executed because the user corrected an earlier tool call. ' +
								'Revise the plan and issue fresh tool calls.',
							isError: true,
						});
					}
					break;
				}
			}
			messages.push(LlmMessage.toolResults(results));
			if (corrected) {
				continue;
			}
		}
		return { kind: 'failed', message: 'The assistant reached its step limit before finishing.' };
	}

	private async runModelTurn(messages: readonly LlmMessage[], tools: readonly ToolSpec[]): Promise<CompleteResult> {
		// Enforce the per-turn timeout: the transport ALSO enforces it, but if a
		// custom client/transport hangs we convert that into a retryable timeout
		// error rather than leaving the UI in Thinking forever.
		try {
			return await withTimeout(this.client.complete(messages, tools, undefined), this.modelTurnTimeoutMs);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: { kind: 'timeout', message } };
		}
	}

	private toErrorOutcome(error: AssistantLlmError): Outcome {
		const message = error.message || 'The assistant request failed.';
		// Retryable: transport / server / rate_limited / timeout.
		if (error.kind === 'transport') {
			return { kind: 'retryable_error', reason: error, message: 'The assistant model transport failed. Try again.' };
		}
		if (error.kind === 'timeout') {
			return { kind: 'retryable_error', reason: error, message: 'The assistant model call timed out. Check the network or try again.' };
		}
		if (error.kind === 'server') {
			return { kind: 'retryable_error', reason: error, message: `The assistant provider returned a server error (HTTP ${error.statusCode}). Try again.` };
		}
		if (error.kind === 'rate_limited') {
			return { kind: 'retryable_error', reason: error, message: 'The assistant provider rate-limited the request. Try again shortly.' };
		}
		return { kind: 'failed', message };
	}

	private async dispatch(
		call: LlmToolCall,
		confirmGate: ConfirmGate,
		choiceGate: ChoiceGate,
	): Promise<DispatchOutcome> {
		const args = parseArgs(call.argumentsJson);
		if (MUTATING_TOOLS.has(call.name)) {
			return this.dispatchMutating(call, args, confirmGate);
		}
		if (call.name === RESOLVE_FOLDER) {
			return this.dispatchResolveFolder(call, args, choiceGate);
		}
		return {
			kind: 'result',
			toolResult: { toolCallId: call.id, content: await this.dispatchInspectOrNav(call.name, args) },
		};
	}

	/**
	 * `resolve_folder` is read-only but gets bespoke dispatch because the
	 * AMBIGUOUS band triggers a clarifying turn: we suspend on the ChoiceGate,
	 * and the user's pick is relayed deterministically back to the model.
	 */
	private async dispatchResolveFolder(
		call: LlmToolCall,
		args: Record<string, unknown>,
		choiceGate: ChoiceGate,
	): Promise<DispatchOutcome> {
		const host = stringArg(args, 'host');
		const query = stringArg(args, 'query');
		const result = await this.actions.resolveFolder(host, query);
		this.emit(call.name, host, null, { host, query }, 'ok');
		if (result.kind === 'unavailable') {
			return { kind: 'result', toolResult: { toolCallId: call.id, content: result.message } };
		}
		const resolution = result.resolution;
		switch (resolution.kind) {
			case 'confident':
				return {
					kind: 'result',
					toolResult: {
						toolCallId: call.id,
						content: `Confident match: ${resolution.candidate.label} at ${resolution.candidate.path}. Use this cwd in start_session.`,
					},
				};
			case 'no_match': {
				const nearest = resolution.nearest
					.map((c) => `${c.label} (${c.path})`)
					.join(', ') || 'none';
				return {
					kind: 'result',
					toolResult: {
						toolCallId: call.id,
						content: `No folder matched "${query}". Nearest folders: ${nearest}. Tell the user it wasn't found and stop unless they clarify.`,
					},
				};
			}
			case 'ambiguous':
				return this.dispatchAmbiguous(call, query, resolution.candidates, choiceGate);
		}
	}

	private async dispatchAmbiguous(
		call: LlmToolCall,
		query: string,
		candidates: readonly FolderCandidate[],
		choiceGate: ChoiceGate,
	): Promise<DispatchOutcome> {
		const decision = await choiceGate(query, candidates);
		switch (decision.kind) {
			case 'pick':
				return {
					kind: 'result',
					toolResult: {
						toolCallId: call.id,
						content: `The user chose ${decision.candidate.label} at ${decision.candidate.path}. Use this cwd in start_session.`,
					},
				};
			case 'cancel':
				return { kind: 'cancel_loop', message: 'Cancelled.' };
		}
	}

	private async dispatchInspectOrNav(name: string, args: Record<string, unknown>): Promise<string> {
		switch (name) {
			case GET_CONTEXT:
				return this.trace(name, null, null, {}, () => this.actions.getContext());
			case LIST_HOSTS:
				return this.trace(name, null, null, {}, () => this.actions.listHosts());
			case LIST_FOLDERS: {
				const host = stringArg(args, 'host');
				return this.trace(name, host, null, { host }, () => this.actions.listFolders(host));
			}
			case LIST_SESSIONS: {
				const host = stringArg(args, 'host');
				return this.trace(name, host, null, { host }, () => this.actions.listSessions(host));
			}
			case LIST_DIRECTORY: {
				const path = stringArg(args, 'path');
				return this.trace(name, null, path, { path }, () => this.actions.listDirectory(path));
			}
			case READ_FILE: {
				const path = stringArg(args, 'path');
				return this.trace(name, null, path, { path }, () => this.actions.readFile(path));
			}
			case LIST_REPOS:
				return this.trace(name, null, null, {}, () => this.actions.listRepos());
			case OPEN_FOLDER: {
				const host = stringArg(args, 'host');
				const path = stringArg(args, 'path');
				return this.trace(name, host, path, { host, path }, () => this.actions.openFolder(host, path));
			}
			case OPEN_SESSION: {
				const s = stringArg(args, 'session_name');
				return this.trace(name, null, null, { session_name: s }, () => this.actions.openSession(s));
			}
			case OPEN_SCREEN: {
				const d = stringArg(args, 'destination');
				return this.trace(name, null, null, { destination: d }, () => this.actions.openScreen(d));
			}
			default:
				return `Unknown tool: ${name}`;
		}
	}

	private async dispatchMutating(
		call: LlmToolCall,
		args: Record<string, unknown>,
		confirmGate: ConfirmGate,
	): Promise<DispatchOutcome> {
		// run_command safety gate runs BEFORE the user ever sees the candidate,
		// so a blocked command is relayed to the model (which can revise)
		// rather than offered for confirmation.
		if (call.name === RUN_COMMAND) {
			const command = stringArg(args, 'command');
			const reason = rejectCommand(command);
			if (reason !== null) {
				return { kind: 'result', toolResult: { toolCallId: call.id, content: reason, isError: true } };
			}
		}
		if (call.name === SEND_PROMPT_TO_SESSION) {
			args = { ...args, prompt: normalizeAgentPrompt(stringArg(args, 'prompt')) };
		}

		const candidate = candidateFor(call.name, args);
		const decision = await confirmGate(candidate);
		switch (decision.kind) {
			case 'confirm': {
				const result = await this.executeMutating(call.name, args);
				return {
					kind: 'result',
					toolResult: { toolCallId: call.id, content: result.message, isError: !result.ok },
				};
			}
			case 'correct':
				// The correction is relayed back to the model as the tool result
				// so the next turn produces a revised candidate.
				return {
					kind: 'result',
					toolResult: {
						toolCallId: call.id,
						content: `The user did not confirm. Their correction: ${decision.correction}`,
						isError: false,
					},
					replan: true,
				};
			case 'cancel':
				return { kind: 'cancel_loop', message: 'Cancelled.' };
		}
	}

	private async executeMutating(name: string, args: Record<string, unknown>): Promise<ActionResult> {
		switch (name) {
			case RUN_COMMAND: {
				const command = stringArg(args, 'command');
				return this.traceAction(name, null, null, { command }, () => this.actions.runCommand(command));
			}
			case CREATE_FILE: {
				const path = stringArg(args, 'path');
				const content = stringArg(args, 'content');
				// Secret hygiene: never put raw file contents in the trace args.
				return this.traceAction(name, null, path, { path, content: REDACTED }, () =>
					this.actions.createFile(path, content),
				);
			}
			case START_SESSION: {
				const host = stringArg(args, 'host');
				const cwd = stringArg(args, 'cwd');
				const agent = stringArg(args, 'agent');
				return this.traceAction(name, host, cwd, { host, cwd, agent }, () =>
					this.actions.startSession(host, cwd, agent),
				);
			}
			case SEND_PROMPT_TO_SESSION: {
				const sessionName = stringArg(args, 'session_name');
				const prompt = stringArg(args, 'prompt');
				return this.traceAction(name, null, null, { session_name: sessionName, prompt: REDACTED }, () =>
					this.actions.sendPromptToSession(sessionName, prompt),
				);
			}
			case CREATE_PROJECT: {
				const host = stringArg(args, 'host');
				const parentPath = stringArg(args, 'parent_path');
				const folderName = stringArg(args, 'folder_name');
				return this.traceAction(name, host, parentPath, { host, parent_path: parentPath, folder_name: folderName }, () =>
					this.actions.createProject(host, parentPath, folderName),
				);
			}
			case CLONE_REPO: {
				const fullName = stringArg(args, 'full_name');
				const folderRaw = stringArg(args, 'folder');
				const folder = folderRaw && folderRaw.trim().length > 0 ? folderRaw : null;
				return this.traceAction(name, null, folder ?? '', { full_name: fullName, folder: folder ?? '' }, () =>
					this.actions.cloneRepo(fullName, folder),
				);
			}
			default:
				return ActionResult.error(`Unknown mutating tool: ${name}`);
		}
	}

	/** Trace an inspect/nav tool, returning its text result. */
	private async trace(
		action: string,
		host: string | null,
		cwd: string | null,
		args: Record<string, string>,
		block: () => Promise<string>,
	): Promise<string> {
		const out = await block();
		this.emit(action, host, cwd, args, 'ok');
		return out;
	}

	/** Trace a mutating action, recording ok/error from its ActionResult. */
	private async traceAction(
		action: string,
		host: string | null,
		cwd: string | null,
		args: Record<string, string>,
		block: () => Promise<ActionResult>,
	): Promise<ActionResult> {
		const result = await block();
		this.emit(action, host, cwd, args, result.ok ? 'ok' : 'error');
		return result;
	}

	private emit(
		action: string,
		host: string | null,
		cwd: string | null,
		args: Record<string, string>,
		result: string,
	): void {
		const event: AssistantTraceEvent = {
			action,
			targetHost: host,
			cwd,
			args,
			result,
			installId: this.installId,
			sessionId: this.sessionId,
		};
		this.traceSink.emit(event);
	}
}

type DispatchOutcome =
	| { kind: 'result'; toolResult: LlmToolResult; replan?: boolean }
	| { kind: 'cancel_loop'; message: string };

/** Parse a tool arguments JSON string into a record; tolerates blank/garbage. */
function parseArgs(json: string): Record<string, unknown> {
	if (!json || json.trim().length === 0) return {};
	try {
		const parsed = JSON.parse(json);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Read a string arg, coercing to '' for missing/non-string values. */
function stringArg(args: Record<string, unknown>, key: string): string {
	const v = args[key];
	return typeof v === 'string' ? v : '';
}

function normalizeAgentPrompt(prompt: string): string {
	return prompt.replace(/эможди/gi, 'эмоджи');
}

function candidateFor(name: string, args: Record<string, unknown>): Candidate {
	switch (name) {
		case RUN_COMMAND:
			return { toolName: name, summary: stringArg(args, 'command') };
		case CREATE_FILE:
			return { toolName: name, summary: `Create file ${stringArg(args, 'path')}` };
		case START_SESSION:
			return {
				toolName: name,
				summary: `Start ${stringArg(args, 'agent')} session in ${stringArg(args, 'cwd')} on ${stringArg(args, 'host')}`,
			};
		case SEND_PROMPT_TO_SESSION:
			return {
				toolName: name,
				summary: `Send prompt to ${stringArg(args, 'session_name')}: ${stringArg(args, 'prompt')}`,
			};
		case CREATE_PROJECT:
			return {
				toolName: name,
				summary: `Create ${stringArg(args, 'folder_name')} in ${stringArg(args, 'parent_path')} on ${stringArg(args, 'host')}`,
			};
		case CLONE_REPO:
			return { toolName: name, summary: `Clone ${stringArg(args, 'full_name')}` };
		default:
			return { toolName: name, summary: name };
	}
}

const noopTraceSink: AssistantTraceSink = { emit() { /* no-op */ } };

/**
 * Race `promise` against a timeout. Resolves with the promise's result, or
 * rejects with a timeout Error after `ms`. The transport also enforces a
 * timeout — this is the loop-level backstop for custom clients that hang.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Model turn timed out after ${ms}ms`)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}
