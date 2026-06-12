/**
 * Unit tests for built-in snippets.
 */

import { describe, it, expect } from 'vitest';
import { builtinSnippets } from '../../../src/commands/builtin/snippets';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('builtinSnippets', () => {
	it('all snippets have required fields', () => {
		for (const snippet of builtinSnippets) {
			expect(snippet.id).toBeTruthy();
			expect(typeof snippet.id).toBe('string');

			expect(snippet.prefix).toBeTruthy();
			expect(typeof snippet.prefix).toBe('string');

			expect(snippet.description).toBeTruthy();
			expect(typeof snippet.description).toBe('string');
		}
	});

	it('all snippet bodies are non-empty arrays', () => {
		for (const snippet of builtinSnippets) {
			expect(Array.isArray(snippet.body)).toBe(true);
			expect(snippet.body.length).toBeGreaterThan(0);

			for (const line of snippet.body) {
				expect(typeof line).toBe('string');
			}
		}
	});

	it('includes the four expected snippets', () => {
		const ids = builtinSnippets.map((s) => s.id);
		expect(ids).toContain('pssh-connect');
		expect(ids).toContain('tmux-new-session');
		expect(ids).toContain('tmux-split-pane');
		expect(ids).toContain('ssh-keygen');
	});

	it('all snippets have unique IDs', () => {
		const ids = builtinSnippets.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('all snippets have unique prefixes', () => {
		const prefixes = builtinSnippets.map((s) => s.prefix);
		expect(new Set(prefixes).size).toBe(prefixes.length);
	});

	it('snippets have correct prefixes', () => {
		const byPrefix = new Map(builtinSnippets.map((s) => [s.prefix, s]));

		expect(byPrefix.get('pssh')?.id).toBe('pssh-connect');
		expect(byPrefix.get('tmuxnew')?.id).toBe('tmux-new-session');
		expect(byPrefix.get('tmuxsplit')?.id).toBe('tmux-split-pane');
		expect(byPrefix.get('sshpkey')?.id).toBe('ssh-keygen');
	});
});
