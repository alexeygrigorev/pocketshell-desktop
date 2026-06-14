/**
 * Command system module for PocketShell Desktop.
 *
 * Re-exports the command registry, chip registry, and keybinding generator
 * so consumers can import everything from a single entry point.
 *
 * NOTE: This barrel intentionally omits the `builtin/` command content
 * modules (ssh-commands, terminal-commands, tmux-commands, snippets).
 * Those are stubs whose rewrite is a deferred follow-up batch; they are
 * not a code dependency of the registry classes re-exported here.
 */

export { CommandRegistry } from './command-registry';
export { CommandChipRegistry, builtinChips } from './chips';
export { generateKeybindings } from './keybinding-generator';
export type { VSCodeKeybinding } from './keybinding-generator';

export type { Command, KeyBinding, Snippet, CommandChip } from './types';
