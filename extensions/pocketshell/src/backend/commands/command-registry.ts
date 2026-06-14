/**
 * Command Registry for PocketShell Desktop.
 *
 * Central registry for all PocketShell commands. Supports registration,
 * lookup, listing by category, and execution.
 */

import type { Command } from './types';

export class CommandRegistry {
	private commands = new Map<string, Command>();

	/**
	 * Register a command. Throws if a command with the same ID already exists.
	 */
	register(command: Command): void {
		if (this.commands.has(command.id)) {
			throw new Error(`Command already registered: ${command.id}`);
		}
		this.commands.set(command.id, command);
	}

	/**
	 * Unregister a command by ID. No-op if not found.
	 */
	unregister(commandId: string): void {
		this.commands.delete(commandId);
	}

	/**
	 * Get a command by ID, or undefined if not found.
	 */
	get(commandId: string): Command | undefined {
		return this.commands.get(commandId);
	}

	/**
	 * List all registered commands.
	 */
	list(): Command[] {
		return Array.from(this.commands.values());
	}

	/**
	 * List commands filtered by category.
	 */
	listByCategory(category: string): Command[] {
		return this.list().filter((cmd) => cmd.category === category);
	}

	/**
	 * Execute a command by ID.
	 *
	 * @throws Error if the command is not found.
	 */
	async execute(commandId: string, args?: any): Promise<any> {
		const command = this.commands.get(commandId);
		if (!command) {
			throw new Error(`Unknown command: ${commandId}`);
		}
		return command.execute(args);
	}
}
