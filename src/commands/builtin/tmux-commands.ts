/**
 * Built-in tmux management commands.
 *
 * Commands for tmux session, window, and pane management.
 */

import type { Command } from '../types';

// ---------------------------------------------------------------------------
// Tmux Commands
// ---------------------------------------------------------------------------

export const tmuxCommands: Command[] = [
	{
		id: 'pocketshell.tmuxNewSession',
		title: 'tmux: New Session',
		category: 'Tmux',
		icon: 'split-horizontal',
		keybinding: {
			key: 'ctrl+shift+n',
			mac: 'cmd+shift+n',
			when: 'pocketshell.connected',
		},
		execute: async (args?: { name?: string; startDir?: string }) => {
			return { action: 'tmuxNewSession', ...args };
		},
	},

	{
		id: 'pocketshell.tmuxKillSession',
		title: 'tmux: Kill Session',
		category: 'Tmux',
		icon: 'trash',
		keybinding: {
			when: 'pocketshell.connected',
		},
		execute: async (args?: { sessionId?: string }) => {
			return { action: 'tmuxKillSession', ...args };
		},
	},

	{
		id: 'pocketshell.tmuxNewWindow',
		title: 'tmux: New Window',
		category: 'Tmux',
		icon: 'add',
		keybinding: {
			key: 'ctrl+shift+t',
			mac: 'cmd+shift+t',
			when: 'pocketshell.connected',
		},
		execute: async (args?: { sessionId?: string; name?: string }) => {
			return { action: 'tmuxNewWindow', ...args };
		},
	},

	{
		id: 'pocketshell.tmuxKillWindow',
		title: 'tmux: Kill Window',
		category: 'Tmux',
		icon: 'close-all',
		keybinding: {
			when: 'pocketshell.connected',
		},
		execute: async (args?: { windowId?: string }) => {
			return { action: 'tmuxKillWindow', ...args };
		},
	},

	{
		id: 'pocketshell.tmuxSplitHorizontal',
		title: 'tmux: Split Horizontal',
		category: 'Tmux',
		icon: 'split-horizontal',
		keybinding: {
			key: 'ctrl+shift+%',
			mac: 'cmd+shift+%',
			when: 'pocketshell.connected',
		},
		execute: async (args?: { paneId?: string }) => {
			return { action: 'tmuxSplitHorizontal', ...args };
		},
	},

	{
		id: 'pocketshell.tmuxSplitVertical',
		title: 'tmux: Split Vertical',
		category: 'Tmux',
		icon: 'split-vertical',
		keybinding: {
			key: 'ctrl+shift+"',
			mac: 'cmd+shift+"',
			when: 'pocketshell.connected',
		},
		execute: async (args?: { paneId?: string }) => {
			return { action: 'tmuxSplitVertical', ...args };
		},
	},

	{
		id: 'pocketshell.tmuxNextPane',
		title: 'tmux: Next Pane',
		category: 'Tmux',
		keybinding: {
			key: 'ctrl+alt+right',
			mac: 'cmd+alt+right',
			when: 'pocketshell.connected',
		},
		execute: async () => {
			return { action: 'tmuxNextPane' };
		},
	},

	{
		id: 'pocketshell.tmuxPrevPane',
		title: 'tmux: Previous Pane',
		category: 'Tmux',
		keybinding: {
			key: 'ctrl+alt+left',
			mac: 'cmd+alt+left',
			when: 'pocketshell.connected',
		},
		execute: async () => {
			return { action: 'tmuxPrevPane' };
		},
	},

	{
		id: 'pocketshell.tmuxCapturePane',
		title: 'tmux: Capture Pane Content',
		category: 'Tmux',
		icon: 'file-text',
		keybinding: {
			when: 'pocketshell.connected',
		},
		execute: async (args?: { paneId?: string; scrollbackLines?: number }) => {
			return { action: 'tmuxCapturePane', ...args };
		},
	},
];
