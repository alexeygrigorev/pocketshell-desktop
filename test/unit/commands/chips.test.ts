/**
 * Unit tests for CommandChipRegistry and built-in chips.
 */

import { describe, it, expect } from 'vitest';
import { CommandChipRegistry, builtinChips } from '../../../src/commands/chips';
import type { CommandChip } from '../../../src/commands/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChip(overrides: Partial<CommandChip> = {}): CommandChip {
	return {
		id: 'test-chip',
		label: 'Test',
		commandId: 'test.command',
		priority: 50,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommandChipRegistry', () => {
	describe('register', () => {
		it('registers and retrieves a chip', () => {
			const registry = new CommandChipRegistry();
			const chip = makeChip({ id: 'chip-a' });
			registry.register(chip);

			const chips = registry.getChips();
			expect(chips).toHaveLength(1);
			expect(chips[0].id).toBe('chip-a');
		});

		it('throws when registering a duplicate ID', () => {
			const registry = new CommandChipRegistry();
			registry.register(makeChip({ id: 'dup' }));

			expect(() => registry.register(makeChip({ id: 'dup' }))).toThrow(
				'Chip already registered: dup',
			);
		});
	});

	describe('unregister', () => {
		it('removes a registered chip', () => {
			const registry = new CommandChipRegistry();
			registry.register(makeChip({ id: 'remove-me' }));
			registry.unregister('remove-me');

			expect(registry.getChips()).toHaveLength(0);
		});

		it('is a no-op for unknown IDs', () => {
			const registry = new CommandChipRegistry();
			expect(() => registry.unregister('no-such-chip')).not.toThrow();
		});
	});

	describe('getChips', () => {
		it('sorts chips by priority (highest first)', () => {
			const registry = new CommandChipRegistry();
			registry.register(makeChip({ id: 'low', priority: 10 }));
			registry.register(makeChip({ id: 'high', priority: 90 }));
			registry.register(makeChip({ id: 'mid', priority: 50 }));

			const chips = registry.getChips();
			expect(chips.map((c) => c.id)).toEqual(['high', 'mid', 'low']);
		});

		it('returns empty array when nothing is registered', () => {
			const registry = new CommandChipRegistry();
			expect(registry.getChips()).toEqual([]);
		});

		it('returns all chips sorted when context is provided', () => {
			const registry = new CommandChipRegistry();
			registry.register(makeChip({ id: 'a', priority: 20 }));
			registry.register(makeChip({ id: 'b', priority: 80 }));

			const chips = registry.getChips('some-context');
			expect(chips).toHaveLength(2);
			expect(chips[0].id).toBe('b');
		});
	});

	describe('built-in chips', () => {
		it('are correctly defined', () => {
			expect(builtinChips.length).toBeGreaterThanOrEqual(3);

			for (const chip of builtinChips) {
				expect(chip.id).toBeTruthy();
				expect(chip.label).toBeTruthy();
				expect(chip.commandId).toBeTruthy();
				expect(typeof chip.priority).toBe('number');
			}
		});

		it('can all be registered without conflicts', () => {
			const registry = new CommandChipRegistry();
			for (const chip of builtinChips) {
				registry.register(chip);
			}

			const chips = registry.getChips();
			expect(chips).toHaveLength(builtinChips.length);
		});

		it('include connection status, tmux session, and terminal count chips', () => {
			const ids = builtinChips.map((c) => c.id);
			expect(ids).toContain('chip-connection-status');
			expect(ids).toContain('chip-active-tmux-session');
			expect(ids).toContain('chip-terminal-count');
		});
	});
});
