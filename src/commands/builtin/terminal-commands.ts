/**
 * Built-in terminal commands.
 *
 * Commands for managing terminal instances: create, close, and navigate.
 */

import type { Command } from '../types';

// ---------------------------------------------------------------------------
// Terminal Commands
// ---------------------------------------------------------------------------

export const terminalCommands: Command[] = [
	{
		id: 'pocketshell.newTerminal',
		title: 'New Terminal',
		category: 'Terminal',
		icon: 'terminal',
		keybinding: {
			key: 'ctrl+shift+`',
			mac: 'cmd+shift+`',
		},
		execute: async () => {
			return { action: 'newTerminal' };
		},
	},

	{
		id: 'pocketshell.closeTerminal',
		title: 'Close Active Terminal',
		category: 'Terminal',
		icon: 'close',
		keybinding: {
			key: 'ctrl+shift+w',
			mac: 'cmd+shift+w',
			when: 'pocketshell.terminalFocused',
		},
		execute: async () => {
			return { action: 'closeTerminal' };
		},
	},

	{
		id: 'pocketshell.nextTerminal',
		title: 'Switch to Next Terminal',
		category: 'Terminal',
		keybinding: {
			key: 'ctrl+pageDown',
			mac: 'cmd+pageDown',
			when: 'pocketshell.terminalFocused',
		},
		execute: async () => {
			return { action: 'nextTerminal' };
		},
	},

	{
		id: 'pocketshell.prevTerminal',
		title: 'Switch to Previous Terminal',
		category: 'Terminal',
		keybinding: {
			key: 'ctrl+pageUp',
			mac: 'cmd+pageUp',
			when: 'pocketshell.terminalFocused',
		},
		execute: async () => {
			return { action: 'prevTerminal' };
		},
	},
];
