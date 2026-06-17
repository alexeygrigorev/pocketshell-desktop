/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SettingsConfigStore } from './settings-config-store';
import { SettingsViewProvider } from './settings-view-provider';

/**
 * Register the dedicated PocketShell Settings view and its open command.
 *
 * This is the single entry point the integration step calls. It:
 *   - registers a WebviewView provider for `pocketshell.settings` (the view
 *     id a future `views` contribution will declare), and
 *   - registers a `pocketshell.settingsView.open` command that focuses the
 *     view, so it can be surfaced from the Command Palette / host detail.
 *
 * @param context The extension activation context (subscriptions are pushed here).
 * @returns The list of disposables created (also pushed onto `context.subscriptions`).
 *
 * NOTE: The view id `pocketshell.settings` and the command
 * `pocketshell.settingsView.open` must be declared in `package.json`
 * `contributes.views` / `contributes.commands` by the integration step —
 * this module does not touch package.json.
 */
export function registerPocketshellSettings(
	context: vscode.ExtensionContext,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const store = new SettingsConfigStore(vscode.ConfigurationTarget.Global);
	const provider = new SettingsViewProvider(context, store);

	disposables.push(
		vscode.window.registerWebviewViewProvider(SettingsViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.settingsView.open', async () => {
			await vscode.commands.executeCommand(`${SettingsViewProvider.viewType}.focus`);
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.settingsView.refresh', async () => {
			await provider.refresh();
		}),
	);

	context.subscriptions.push(...disposables);
	return disposables;
}
