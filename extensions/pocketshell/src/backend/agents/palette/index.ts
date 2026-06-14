/**
 * Slash-command palette module for PocketShell Desktop.
 *
 * Manages registration, fuzzy search, and execution of agent slash commands.
 * The palette is a host-agnostic in-memory registry; it performs no I/O.
 */

export { SlashCommandPalette } from './command-palette';
export { fuzzyMatch } from './fuzzy-matcher';
export type { FuzzyMatchResult } from './fuzzy-matcher';
export type { SlashCommand, PaletteItem, PaletteState } from './types';
