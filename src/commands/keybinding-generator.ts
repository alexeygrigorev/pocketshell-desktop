/**
 * Keybinding Generator for PocketShell Desktop.
 *
 * Converts Command[] into VS Code keybinding JSON format for
 * package.json `contributes.keybindings`.
 */

import type { Command, KeyBinding } from './types';

// ---------------------------------------------------------------------------
// VS Code Keybinding Format
// ---------------------------------------------------------------------------

export interface VSCodeKeybinding {
	/** The command to invoke */
	command: string;
	/** Key chord */
	key: string;
	/** macOS override */
	mac?: string;
	/** Linux override */
	linux?: string;
	/** Windows override */
	win?: string;
	/** When clause for context-aware binding */
	when?: string;
	/** Optional human-readable label */
	// (not part of VS Code schema but useful for documentation)
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Convert a single KeyBinding + command ID to VS Code keybinding format.
 */
function toVSCodeKeybinding(commandId: string, kb: KeyBinding): VSCodeKeybinding {
	const result: VSCodeKeybinding = {
		command: commandId,
		key: kb.key,
	};

	if (kb.mac) result.mac = kb.mac;
	if (kb.linux) result.linux = kb.linux;
	if (kb.win) result.win = kb.win;
	if (kb.when) result.when = kb.when;

	return result;
}

/**
 * Generate VS Code keybinding entries from an array of commands.
 *
 * Only commands with keybindings are included. Platform-specific overrides
 * (mac/linux/win) are folded into the same entry per VS Code convention.
 */
export function generateKeybindings(commands: Command[]): VSCodeKeybinding[] {
	const result: VSCodeKeybinding[] = [];

	for (const cmd of commands) {
		if (cmd.keybinding && cmd.keybinding.key) {
			result.push(toVSCodeKeybinding(cmd.id, cmd.keybinding));
		}
	}

	return result;
}
