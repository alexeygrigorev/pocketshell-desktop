/**
 * Command Chip Registry for PocketShell Desktop.
 *
 * Manages command chips — small interactive elements for the status bar
 * or chip bar that trigger commands when clicked.
 */

import type { CommandChip } from './types';

// ---------------------------------------------------------------------------
// Built-in Chips
// ---------------------------------------------------------------------------

export const builtinChips: CommandChip[] = [
	{
		id: 'chip-connection-status',
		label: 'Disconnected',
		icon: 'plug',
		commandId: 'pocketshell.connect',
		tooltip: 'SSH Connection Status — click to connect',
		priority: 100,
	},

	{
		id: 'chip-active-tmux-session',
		label: 'No tmux session',
		icon: 'terminal-tmux',
		commandId: 'pocketshell.tmuxNewSession',
		tooltip: 'Active tmux session — click to manage',
		priority: 80,
	},

	{
		id: 'chip-terminal-count',
		label: '0 terminals',
		icon: 'terminal',
		commandId: 'pocketshell.newTerminal',
		tooltip: 'Active terminals — click to open a new one',
		priority: 60,
	},
];

// ---------------------------------------------------------------------------
// Command Chip Registry
// ---------------------------------------------------------------------------

export class CommandChipRegistry {
	private chips = new Map<string, CommandChip>();

	/**
	 * Register a chip. Throws if a chip with the same ID already exists.
	 */
	register(chip: CommandChip): void {
		if (this.chips.has(chip.id)) {
			throw new Error(`Chip already registered: ${chip.id}`);
		}
		this.chips.set(chip.id, chip);
	}

	/**
	 * Unregister a chip by ID. No-op if not found.
	 */
	unregister(chipId: string): void {
		this.chips.delete(chipId);
	}

	/**
	 * Get chips, optionally filtered by scope/context, sorted by priority
	 * (highest first).
	 */
	getChips(context?: string): CommandChip[] {
		const all = Array.from(this.chips.values());

		if (context) {
			// Future: filter chips based on context.
			// For now all chips are returned; context-based filtering
			// will be added when the UI context system is in place.
			return all.sort((a, b) => b.priority - a.priority);
		}

		return all.sort((a, b) => b.priority - a.priority);
	}
}
