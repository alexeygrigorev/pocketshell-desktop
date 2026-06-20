/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import type { FeatureDeps } from '../manifest';
import { CommandRegistry } from '../../backend/commands';
import { SlashCommandPalette } from '../../backend/agents/palette';
import type { Command } from '../../backend/commands';
import type { SlashCommand } from '../../backend/agents/palette';
import {
	SNIPPET_LIBRARY_STATE_KEY,
	parseSnippetLibrary,
	snippetToPaletteCommand,
} from '../../backend/agents/snippets';

/**
 * Palette feature: registers commands that wire the slash-command
 * {@link SlashCommandPalette} (fuzzy search + execute) together with the
 * {@link CommandRegistry} (the backing store of registered commands).
 *
 * Both classes are host-agnostic in-memory registries, so unlike the git
 * feature this module performs no SSH connection — the palette is pure UI
 * over local command registrations. A single shared registry + palette
 * instance is kept at module scope so state persists across invocations.
 */

// Shared singletons — kept for the lifetime of the extension.
const registry = new CommandRegistry();
const palette = new SlashCommandPalette();

/**
 * Adapt a registered {@link Command} into a {@link SlashCommand} the palette
 * can render and execute. The slash `prefix` is derived from the command id
 * when the command carries no explicit prefix of its own.
 */
function toSlashCommand(command: Command): SlashCommand {
	return {
		id: command.id,
		prefix: `/${command.id.split('.').pop() ?? command.id}`,
		label: command.title,
		description: command.category ?? 'PocketShell',
		category: command.category ?? 'PocketShell',
		icon: command.icon,
		execute: (args) => command.execute(args),
	};
}

/** Sync the palette from the registry: rebuild slash commands from scratch. */
function syncPaletteFromRegistry(): void {
	for (const cmd of palette.listAll()) {
		palette.unregister(cmd.id);
	}
	for (const cmd of registry.list()) {
		palette.register(toSlashCommand(cmd));
	}
}

function syncPaletteFromSnippets(ctx: vscode.ExtensionContext): void {
	// Read from globalState (the post-#105 home of the snippet library). Fall
	// back to legacy workspaceState so the palette stays populated during the
	// one-time migration window (see SnippetLibraryStore.migrateFromWorkspaceState).
	const fromGlobal = ctx.globalState.get(SNIPPET_LIBRARY_STATE_KEY, undefined);
	const raw = fromGlobal !== undefined
		? fromGlobal
		: ctx.workspaceState.get(SNIPPET_LIBRARY_STATE_KEY, []);
	for (const snippet of parseSnippetLibrary(raw)) {
		const descriptor = snippetToPaletteCommand(snippet);
		palette.register({
			id: descriptor.id,
			prefix: descriptor.prefix,
			label: descriptor.label,
			description: descriptor.description,
			category: descriptor.category,
			icon: descriptor.icon,
			execute: async () => {
				await vscode.commands.executeCommand('pocketshell.snippets.run', { snippetId: descriptor.snippetId });
			},
		});
	}
}

function syncPalette(ctx: vscode.ExtensionContext): void {
	syncPaletteFromRegistry();
	syncPaletteFromSnippets(ctx);
}

export function registerPalette(
	_service: ConnectionService,
	ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	// -------------------------------------------------------------------------
	// pocketshell.palette.open — show the slash-command palette (QuickPick)
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.palette.open', async () => {
			syncPalette(ctx);
			const items = palette.search('').map(({ command }) => ({
				label: command.prefix,
				description: command.label,
				detail: command.description,
				alwaysShow: true,
				commandId: command.id,
			}));

			// VS Code's QuickPick performs live filtering on the displayed
			// label/description/detail; the palette's fuzzy matcher ranks the
			// initial population shown when the picker opens.
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: vscode.l10n.t('Type to search slash commands'),
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (picked === undefined) {
				return;
			}

			const match = palette.get(picked.commandId);
			if (match === undefined) {
				return;
			}
			try {
				await match.execute();
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Palette command failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.palette.listCommands — list every registered command
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.palette.listCommands', async () => {
			syncPalette(ctx);
			const commands = palette.listAll();
			if (commands.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t('No commands registered.'),
				);
				return;
			}

			const items = commands
				.slice()
				.sort((a, b) => {
					const catCmp = a.category.localeCompare(b.category);
					if (catCmp !== 0) return catCmp;
					return a.label.localeCompare(b.label);
				})
				.map((cmd) => ({
					label: cmd.prefix,
					description: cmd.label,
					detail: cmd.description,
					commandId: cmd.id,
				}));

			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: vscode.l10n.t(
					'{0} command(s) registered',
					String(commands.length),
				),
			});
			if (picked === undefined) {
				return;
			}

			try {
				const command = palette.get(picked.commandId);
				await command?.execute();
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Command failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.palette.registerCommand — register a new command at runtime
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.palette.registerCommand', async () => {
			const id = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Command id (e.g. myplugin.run)'),
				validateInput: (v) => (v.trim().length === 0 ? 'id is required' : undefined),
			});
			if (id === undefined) {
				return;
			}
			if (registry.get(id) !== undefined) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Command already registered: {0}', id),
				);
				return;
			}

			const title = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Display title'),
				validateInput: (v) => (v.trim().length === 0 ? 'title is required' : undefined),
			});
			if (title === undefined) {
				return;
			}

			const category = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Category'),
				value: 'PocketShell',
			});
			if (category === undefined) {
				return;
			}

			const command: Command = {
				id,
				title,
				category: category.length > 0 ? category : 'PocketShell',
				execute: async () => {
					vscode.window.showInformationMessage(
						vscode.l10n.t('Ran {0}', id),
					);
				},
			};

			try {
				registry.register(command);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Register failed: {0}', String(err)),
				);
				return;
			}
			syncPalette(ctx);

			vscode.window.showInformationMessage(
				vscode.l10n.t('Registered {0}', id),
			);
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.palette.refreshSnippets', async () => {
			syncPalette(ctx);
		}),
	);

	return disposables;
}
