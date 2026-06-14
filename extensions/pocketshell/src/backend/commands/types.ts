/**
 * Command system types for PocketShell Desktop.
 *
 * Defines the core interfaces for commands, key bindings, snippets,
 * and command chips.
 */

// ---------------------------------------------------------------------------
// Key Binding
// ---------------------------------------------------------------------------

export interface KeyBinding {
	/** Key chord, e.g. 'ctrl+shift+t', 'ctrl+k ctrl+c' */
	key: string;
	/** Context expression, e.g. 'pocketshell.connected' */
	when?: string;
	/** macOS override, e.g. 'cmd+shift+t' */
	mac?: string;
	/** Linux override */
	linux?: string;
	/** Windows override */
	win?: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface Command {
	/** Unique command ID, e.g. 'pocketshell.connect' */
	id: string;
	/** Display title for command palette */
	title: string;
	/** Category for grouping, e.g. 'PocketShell', 'Terminal', 'Tmux' */
	category?: string;
	/** Codicon name for UI display */
	icon?: string;
	/** Optional key binding */
	keybinding?: KeyBinding;
	/** Execute the command */
	execute(args?: any): Promise<any>;
}

// ---------------------------------------------------------------------------
// Snippet
// ---------------------------------------------------------------------------

export interface Snippet {
	/** Unique snippet ID */
	id: string;
	/** Trigger text, e.g. 'pssh' */
	prefix: string;
	/** Snippet body lines */
	body: string[];
	/** Human-readable description */
	description: string;
	/** Context scope, e.g. 'terminal' */
	scope?: string;
}

// ---------------------------------------------------------------------------
// Command Chip
// ---------------------------------------------------------------------------

export interface CommandChip {
	/** Unique chip ID */
	id: string;
	/** Display label */
	label: string;
	/** Codicon name */
	icon?: string;
	/** Command to invoke when chip is clicked */
	commandId: string;
	/** Arguments to pass to the command */
	args?: any;
	/** Tooltip shown on hover */
	tooltip?: string;
	/** Priority for ordering in chip bar (higher = more prominent) */
	priority: number;
}
