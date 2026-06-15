/**
 * Slash Command Palette for PocketShell Desktop.
 *
 * Manages registration, search, and execution of slash commands
 * for agent operations. Uses fuzzy matching for search.
 */

import type { SlashCommand, PaletteItem } from './types';
import { fuzzyMatch } from './fuzzy-matcher';

export class SlashCommandPalette {
  private commands = new Map<string, SlashCommand>();

  constructor(commands: SlashCommand[] = []) {
    for (const cmd of commands) {
      this.commands.set(cmd.id, cmd);
    }
  }

  /**
   * Register a new slash command.
   * Overwrites any existing command with the same ID.
   */
  register(command: SlashCommand): void {
    this.commands.set(command.id, command);
  }

  /**
   * Unregister a slash command by its ID.
   * No-op if the command is not found.
   */
  unregister(commandId: string): void {
    this.commands.delete(commandId);
  }

  /**
   * Look up a registered slash command by exact ID.
   */
  get(commandId: string): SlashCommand | undefined {
    return this.commands.get(commandId);
  }

  /**
   * List all registered slash commands.
   */
  listAll(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  /**
   * Search commands by fuzzy matching the query against
   * the command prefix, label, and description.
   *
   * Returns items sorted by match score (highest first).
   * An empty query returns all commands with neutral scoring.
   */
  search(query: string): PaletteItem[] {
    const commands = this.listAll();

    if (query.length === 0) {
      // Empty query: return all commands with equal score, sorted by category then label
      return commands
        .map((command) => ({ command, score: 1, highlights: [] as [number, number][] }))
        .sort((a, b) => {
          const catCmp = a.command.category.localeCompare(b.command.category);
          if (catCmp !== 0) return catCmp;
          return a.command.label.localeCompare(b.command.label);
        });
    }

    const results: PaletteItem[] = [];

    for (const command of commands) {
      // Try matching against prefix (highest priority text), label, then description
      const candidates = [
        { text: command.prefix, weight: 3 },
        { text: command.label, weight: 2 },
        { text: command.description, weight: 1 },
      ];

      let bestResult: PaletteItem | null = null;

      for (const { text, weight } of candidates) {
        const match = fuzzyMatch(query, text);
        if (match !== null) {
          const weightedScore = match.score * weight;
          if (!bestResult || weightedScore > bestResult.score) {
            bestResult = {
              command,
              score: weightedScore,
              highlights: match.highlights,
            };
          }
        }
      }

      if (bestResult !== null) {
        results.push(bestResult);
      }
    }

    // Sort by score descending, then by label for stable ordering
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.command.label.localeCompare(b.command.label);
    });

    return results;
  }

  /**
   * Execute the command at the given index in the current search results.
   *
   * @throws Error if the index is out of bounds.
   */
  async executeSelected(
    results: PaletteItem[],
    index: number,
    args?: string,
  ): Promise<void> {
    if (index < 0 || index >= results.length) {
      throw new Error(
        `Invalid selection index: ${index} (results length: ${results.length})`,
      );
    }
    await results[index].command.execute(args);
  }
}
