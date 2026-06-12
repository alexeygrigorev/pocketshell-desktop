/**
 * Unit tests for CommandRegistry.
 */

import { describe, it, expect } from 'vitest';
import { CommandRegistry } from '../../../src/commands/command-registry';
import type { Command } from '../../../src/commands/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCommand(overrides: Partial<Command> = {}): Command {
	return {
		id: 'test.command',
		title: 'Test Command',
		category: 'Test',
		execute: async () => 'executed',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommandRegistry', () => {
	describe('register', () => {
		it('registers and retrieves a command', () => {
			const registry = new CommandRegistry();
			const cmd = makeCommand({ id: 'pocketshell.connect' });
			registry.register(cmd);

			expect(registry.get('pocketshell.connect')).toBe(cmd);
		});

		it('throws when registering a duplicate ID', () => {
			const registry = new CommandRegistry();
			registry.register(makeCommand({ id: 'dup' }));

			expect(() => registry.register(makeCommand({ id: 'dup' }))).toThrow(
				'Command already registered: dup',
			);
		});
	});

	describe('unregister', () => {
		it('removes a registered command', () => {
			const registry = new CommandRegistry();
			registry.register(makeCommand({ id: 'remove.me' }));
			registry.unregister('remove.me');

			expect(registry.get('remove.me')).toBeUndefined();
		});

		it('is a no-op for unknown IDs', () => {
			const registry = new CommandRegistry();
			expect(() => registry.unregister('no.such.id')).not.toThrow();
		});
	});

	describe('list', () => {
		it('returns all registered commands', () => {
			const registry = new CommandRegistry();
			const c1 = makeCommand({ id: 'a' });
			const c2 = makeCommand({ id: 'b' });
			registry.register(c1);
			registry.register(c2);

			const list = registry.list();
			expect(list).toHaveLength(2);
			expect(list.map((c) => c.id).sort()).toEqual(['a', 'b']);
		});

		it('returns empty array when nothing is registered', () => {
			const registry = new CommandRegistry();
			expect(registry.list()).toEqual([]);
		});
	});

	describe('listByCategory', () => {
		it('filters commands by category', () => {
			const registry = new CommandRegistry();
			registry.register(makeCommand({ id: 'a', category: 'PocketShell' }));
			registry.register(makeCommand({ id: 'b', category: 'Terminal' }));
			registry.register(makeCommand({ id: 'c', category: 'PocketShell' }));

			const result = registry.listByCategory('PocketShell');
			expect(result).toHaveLength(2);
			expect(result.every((c) => c.category === 'PocketShell')).toBe(true);
		});

		it('returns empty for a category with no commands', () => {
			const registry = new CommandRegistry();
			registry.register(makeCommand({ id: 'a', category: 'Terminal' }));
			expect(registry.listByCategory('Tmux')).toEqual([]);
		});
	});

	describe('execute', () => {
		it('calls the command handler and returns the result', async () => {
			const registry = new CommandRegistry();
			let called = false;
			registry.register(
				makeCommand({
					id: 'exec.test',
					execute: async (args: any) => {
						called = true;
						return { ok: true, args };
					},
				}),
			);

			const result = await registry.execute('exec.test', { x: 42 });
			expect(called).toBe(true);
			expect(result).toEqual({ ok: true, args: { x: 42 } });
		});

		it('throws for unknown commands', async () => {
			const registry = new CommandRegistry();
			await expect(registry.execute('no.such.command')).rejects.toThrow(
				'Unknown command: no.such.command',
			);
		});
	});
});
