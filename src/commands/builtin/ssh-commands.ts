/**
 * Built-in SSH connection commands.
 *
 * Commands for managing SSH hosts: connect, disconnect, host management.
 */

import type { Command } from '../types';

// ---------------------------------------------------------------------------
// SSH Commands
// ---------------------------------------------------------------------------

export const sshCommands: Command[] = [
	{
		id: 'pocketshell.connect',
		title: 'Connect to Host',
		category: 'PocketShell',
		icon: 'plug',
		keybinding: {
			key: 'ctrl+shift+c',
			mac: 'cmd+shift+c',
		},
		execute: async (args?: { hostId?: number; hostName?: string }) => {
			// Actual connection logic is wired by the application layer.
			// Commands provide the binding surface; execution delegates to
			// injected services at registration time.
			return { action: 'connect', ...args };
		},
	},

	{
		id: 'pocketshell.disconnect',
		title: 'Disconnect from Current Host',
		category: 'PocketShell',
		icon: 'debug-disconnect',
		keybinding: {
			key: 'ctrl+shift+d',
			mac: 'cmd+shift+d',
			when: 'pocketshell.connected',
		},
		execute: async () => {
			return { action: 'disconnect' };
		},
	},

	{
		id: 'pocketshell.manageHosts',
		title: 'Manage Hosts',
		category: 'PocketShell',
		icon: 'server',
		execute: async () => {
			return { action: 'manageHosts' };
		},
	},
];
