/**
 * Built-in snippets for common tmux/SSH operations.
 *
 * Snippets are expandable text templates triggered by a short prefix
 * in the terminal or command palette.
 */

import type { Snippet } from '../types';

// ---------------------------------------------------------------------------
// Built-in Snippets
// ---------------------------------------------------------------------------

export const builtinSnippets: Snippet[] = [
	{
		id: 'pssh-connect',
		prefix: 'pssh',
		body: [
			'# Connect to a PocketShell host',
			'# Usage: pocketshell.connect hostId=<id>',
			'pocketshell.connect',
		],
		description: 'PocketShell connect snippet — connect to an SSH host',
		scope: 'terminal',
	},

	{
		id: 'tmux-new-session',
		prefix: 'tmuxnew',
		body: [
			'tmux new-session -d -s "${1:session_name}"',
			'# Switch to the session:',
			'tmux switch-client -t "${1:session_name}"',
		],
		description: 'Create a new tmux session with a given name',
		scope: 'terminal',
	},

	{
		id: 'tmux-split-pane',
		prefix: 'tmuxsplit',
		body: [
			'# Split pane: use -h for horizontal, omit for vertical',
			'tmux split-window ${1:-h} -t "${2:pane_id}"',
		],
		description: 'Split a tmux pane horizontally or vertically',
		scope: 'terminal',
	},

	{
		id: 'ssh-keygen',
		prefix: 'sshpkey',
		body: [
			'ssh-keygen -t ed25519 -C "${1:your_email@example.com}" -f ~/.ssh/id_ed25519',
			'# Copy public key to remote host:',
			'ssh-copy-id -i ~/.ssh/id_ed25519.pub ${2:user@host}',
		],
		description: 'Generate an SSH key pair and copy it to a remote host',
		scope: 'terminal',
	},
];
