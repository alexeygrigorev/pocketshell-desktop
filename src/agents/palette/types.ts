/**
 * Slash-command palette types for PocketShell Desktop.
 *
 * Defines the core interfaces for the agent slash-command palette
 * system — a quick-access menu for agent operations.
 */

import type { SshConnection } from '../../ssh/connection/ssh-client';

// ---------------------------------------------------------------------------
// PaletteBuiltinServices
// ---------------------------------------------------------------------------

/**
 * Host-side services injected into the built-in slash commands so their
 * `execute()` bodies can reach a real SSH connection and render output
 * without depending on the VS Code API (which is unavailable in the
 * pure-node `src/` tree).
 *
 * The extension supplies a concrete implementation built on its
 * `ConnectionService`, `resolveHostId`, `getOrConnect`, and an
 * `OutputChannel`; the unit tests call the factories with no services, in
 * which case every command falls back to its stub behaviour.
 */
export interface PaletteBuiltinServices {
  /**
   * Resolve a connected host (prompting the user when necessary) and return
   * a live {@link SshConnection}. Returns null when the user cancelled or the
   * connection failed (UI already shown by the caller).
   */
  resolveConnection(): Promise<SshConnection | null>;

  /**
   * Append a batch of rendered lines to the shared palette output surface
   * (an `OutputChannel` in the extension). Each string is one line.
   */
  render(lines: string[]): void;
}

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
