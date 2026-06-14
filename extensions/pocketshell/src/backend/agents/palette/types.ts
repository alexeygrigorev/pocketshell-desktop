/**
 * Slash-command palette types for PocketShell Desktop.
 *
 * Defines the core interfaces for the agent slash-command palette
 * system — a quick-access menu for agent operations.
 */

// ---------------------------------------------------------------------------
// SlashCommand
// ---------------------------------------------------------------------------

/** A single slash command available in the palette. */
export interface SlashCommand {
  /** Unique command ID, e.g. 'agent.detect' */
  id: string;

  /** Slash prefix used to trigger, e.g. '/session', '/agent', '/usage' */
  prefix: string;

  /** Display label shown in the palette UI. */
  label: string;

  /** Short description of what the command does. */
  description: string;

  /** Category for grouping in the palette, e.g. 'Session', 'Agent' */
  category: string;

  /** Optional codicon name for UI display. */
  icon?: string;

  /** Execute the command with optional string argument. */
  execute(args?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// PaletteItem
// ---------------------------------------------------------------------------

/** A palette entry after fuzzy matching, with score and highlight info. */
export interface PaletteItem {
  /** The matched slash command. */
  command: SlashCommand;

  /** Fuzzy match score (higher = better match). */
  score: number;

  /** Matched character ranges for UI highlighting. */
  highlights: [number, number][];
}

// ---------------------------------------------------------------------------
// PaletteState
// ---------------------------------------------------------------------------

/** Current state of the palette UI. */
export interface PaletteState {
  /** The current search query typed by the user. */
  query: string;

  /** Filtered and ranked palette items. */
  items: PaletteItem[];

  /** Index of the currently selected item. */
  selectedIndex: number;
}
