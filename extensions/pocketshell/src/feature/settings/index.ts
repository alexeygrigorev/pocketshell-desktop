/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SettingsConfigStore } from './settings-config-store';
import { SettingsViewPanel } from './settings-view-provider';

/**
 * Register the on-demand PocketShell Settings editor-area panel and its
 * commands (#89, relocated out of the sidebar by #99).
 *
 * The sidebar used to host a `WebviewView` (id `pocketshell.settings`). Per
 * #99 the sidebar now hosts ONLY the session tree, so Settings opens on
 * demand as an editor-area `WebviewPanel` via `pocketshell.settingsView.open`
 * (reachable from the Command Palette; the title `PocketShell: Open Settings
 * View` carries the `PocketShell` category).
 *
 * NOTE: The command ids `pocketshell.settingsView.open` and
 * `pocketshell.settingsView.refresh` are declared in `package.json`
 * `contributes.commands` by the integration step — this module does not touch
 * package.json. `pocketshell.settings.open` (a separate QuickPick command
 * registered in extension.ts) is unaffected.
 *
 * @param context The extension activation context (subscriptions are pushed here).
 * @returns The list of disposables created (also pushed onto `context.subscriptions`).
 */
export function registerPocketshellSettings(
	context: vscode.ExtensionContext,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const store = new SettingsConfigStore(vscode.ConfigurationTarget.Global);

	// Keep a handle so the refresh command can target the live panel. Undefined
	// when no panel is open; SettingsViewPanel.open re-focuses an existing panel.
	let current: SettingsViewPanel | undefined;

	disposables.push(
		vscode.commands.registerCommand('pocketshell.settingsView.open', () => {
			current = SettingsViewPanel.open(store);
			return current;
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.settingsView.refresh', async () => {
			await current?.refresh();
		}),
	);

	context.subscriptions.push(...disposables);
	return disposables;
}
