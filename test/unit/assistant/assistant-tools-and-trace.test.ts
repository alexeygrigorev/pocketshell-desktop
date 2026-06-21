/**
 * Catalog + trace sanity tests.
 *
 * Guards the 17-tool catalog count, the 6-entry MUTATING_TOOLS set, the
 * parametersJsonSchema validity (parses as JSON), and the trace event
 * serialization shape (redaction sentinel, source=desktop, kind=agent_action).
 */

import { describe, it, expect } from 'vitest';
import {
	ASSISTANT_TOOLS,
	MUTATING_TOOLS,
	isMutating,
	START_SESSION,
	SEND_PROMPT_TO_SESSION,
	CREATE_PROJECT,
	RUN_COMMAND,
	CREATE_FILE,
	CLONE_REPO,
} from '../../../src/assistant/assistant-tools';
import { traceEventToJson, REDACTED, NOOP_TRACE_SINK } from '../../../src/assistant/assistant-trace';

describe('AssistantTools catalog', () => {
	it('declares exactly 17 tools', () => {
		expect(ASSISTANT_TOOLS).toHaveLength(17);
	});

	it('every tool has a unique name + a valid JSON parameters schema', () => {
		const names = new Set<string>();
		for (const tool of ASSISTANT_TOOLS) {
			expect(names.has(tool.name)).toBe(false);
			names.add(tool.name);
			expect(() => JSON.parse(tool.parametersJsonSchema)).not.toThrow();
		}
	});

	it('every tool has a non-empty description', () => {
		for (const tool of ASSISTANT_TOOLS) {
			expect(tool.description.length).toBeGreaterThan(10);
		}
	});

	it('MUTATING_TOOLS has exactly 6 members', () => {
		expect(MUTATING_TOOLS.size).toBe(6);
		expect([...MUTATING_TOOLS].sort()).toEqual(
			[CLONE_REPO, CREATE_FILE, CREATE_PROJECT, RUN_COMMAND, SEND_PROMPT_TO_SESSION, START_SESSION].sort(),
		);
	});

	it('isMutating flags the 6 mutating tools', () => {
		expect(isMutating('start_session')).toBe(true);
		expect(isMutating('list_hosts')).toBe(false);
		expect(isMutating('resolve_folder')).toBe(false);
	});
});

describe('AssistantTrace serialization', () => {
	it('traceEventToJson produces the #270 ingest shape with source=desktop', () => {
		const json = traceEventToJson({
			action: 'run_command',
			targetHost: 'prod',
			cwd: '/p',
			args: { command: 'ls', content: REDACTED },
			result: 'ok',
			installId: 'install-uuid',
			sessionId: 'sess-1',
			timestampMillis: 12345,
		});
		const parsed = JSON.parse(json);
		expect(parsed.ts).toBe(12345);
		expect(parsed.source).toBe('desktop');
		expect(parsed.kind).toBe('agent_action');
		expect(parsed.action).toBe('run_command');
		expect(parsed.target_host).toBe('prod');
		expect(parsed.cwd).toBe('/p');
		expect(parsed.args.command).toBe('ls');
		expect(parsed.args.content).toBe('<redacted>');
		expect(parsed.result).toBe('ok');
		expect(parsed.install_id).toBe('install-uuid');
		expect(parsed.session_id).toBe('sess-1');
	});

	it('null host/cwd/sessionId are serialised as null (not omitted)', () => {
		const parsed = JSON.parse(
			traceEventToJson({
				action: 'list_hosts',
				targetHost: null,
				cwd: null,
				args: {},
				result: 'ok',
				installId: 'id',
				sessionId: null,
				timestampMillis: 1,
			}),
		);
		expect(parsed.target_host).toBeNull();
		expect(parsed.cwd).toBeNull();
		expect(parsed.session_id).toBeNull();
	});

	it('NOOP_TRACE_SINK.emit is a no-op (does not throw)', () => {
		expect(() =>
			NOOP_TRACE_SINK.emit({
				action: 'x',
				targetHost: null,
				cwd: null,
				args: {},
				result: 'ok',
				installId: 'i',
				sessionId: null,
			}),
		).not.toThrow();
	});
});
