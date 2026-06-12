/**
 * Unit tests for the keybinding generator.
 */

import { describe, it, expect } from 'vitest';
import { generateKeybindings } from '../../../src/commands/keybinding-generator';
import type { Command } from '../../../src/commands/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCommand(overrides: Partial<Command> = {}): Command {
	return {
		id: 'test.command',
		title: 'Test',
		execute: async () => {},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateKeybindings', () => {
	it('generates VS Code format keybindings from commands', () => {
		const commands: Command[] = [
			makeCommand({
				id: 'pocketshell.connect',
				keybinding: { key: 'ctrl+shift+c', mac: 'cmd+shift+c' },
			}),
			makeCommand({
				id: 'pocketshell.newTerminal',
				keybinding: { key: 'ctrl+shift+`', mac: 'cmd+shift+`' },
			}),
		];

		const result = generateKeybindings(commands);

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			command: 'pocketshell.connect',
			key: 'ctrl+shift+c',
			mac: 'cmd+shift+c',
		});
		expect(result[1]).toEqual({
			command: 'pocketshell.newTerminal',
			key: 'ctrl+shift+`',
			mac: 'cmd+shift+`',
		});
	});

	it('applies platform-specific overrides', () => {
		const commands: Command[] = [
			makeCommand({
				id: 'test.platform',
				keybinding: {
					key: 'ctrl+shift+t',
					mac: 'cmd+shift+t',
					linux: 'ctrl+shift+t',
					win: 'ctrl+shift+t',
				},
			}),
		];

		const result = generateKeybindings(commands);

		expect(result[0]).toEqual({
			command: 'test.platform',
			key: 'ctrl+shift+t',
			mac: 'cmd+shift+t',
			linux: 'ctrl+shift+t',
			win: 'ctrl+shift+t',
		});
	});

	it('includes when clause when present', () => {
		const commands: Command[] = [
			makeCommand({
				id: 'test.when',
				keybinding: {
					key: 'ctrl+shift+w',
					when: 'pocketshell.connected',
				},
			}),
		];

		const result = generateKeybindings(commands);

		expect(result[0]).toEqual({
			command: 'test.when',
			key: 'ctrl+shift+w',
			when: 'pocketshell.connected',
		});
	});

	it('skips commands without keybindings', () => {
		const commands: Command[] = [
			makeCommand({ id: 'no.binding' }),
			makeCommand({
				id: 'has.binding',
				keybinding: { key: 'ctrl+k' },
			}),
		];

		const result = generateKeybindings(commands);
		expect(result).toHaveLength(1);
		expect(result[0].command).toBe('has.binding');
	});

	it('skips commands with keybinding object but no key', () => {
		const commands: Command[] = [
			makeCommand({
				id: 'empty.binding',
				keybinding: { when: 'pocketshell.connected' },
			}),
		];

		const result = generateKeybindings(commands);
		expect(result).toHaveLength(0);
	});

	it('returns empty for empty input', () => {
		expect(generateKeybindings([])).toEqual([]);
	});
});
