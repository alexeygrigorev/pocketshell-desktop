/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import type { FeatureDeps } from '../manifest';
import { getTerminalManager } from './index';

/**
 * Terminal feature: registers commands that drive the TerminalManager
 * singleton over an SSH connection.
 *
 * The manager is owned by the feature module (see index.ts) and exposed via
 * `getTerminalManager()` so later batches (tmux-ui) can read sessions without
 * re-editing extension.ts. Commands manage multi-session lifecycle:
 * new session, list sessions, close session.
 */
export function registerTerminal(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const manager = getTerminalManager();
	if (!manager) {
		throw new Error('TerminalManager is not registered');
	}

	// -------------------------------------------------------------------------
	// pocketshell.terminal.new — create a new SSH terminal session
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.terminal.new', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const name = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Session name (optional)'),
			});

			try {
				await manager.createTerminal(hostId, conn, name ? { name } : undefined);
				vscode.window.showInformationMessage(
					vscode.l10n.t('Terminal session created ({0} active)', String(manager.count)),
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to create terminal: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.terminal.list — list tracked sessions via quick-pick
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.terminal.list', async () => {
			const terminals = manager.listTerminals();
			if (terminals.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t('No terminal sessions.'),
				);
				return;
			}

			const items = terminals.map((t) => ({
				label: t.name,
				description: t.isActive ? 'active' : 'inactive',
				detail: `${t.id} · host ${t.hostId}`,
				terminal: t,
			}));

			await vscode.window.showQuickPick(items, {
				placeHolder: vscode.l10n.t('Terminal sessions ({0})', String(terminals.length)),
			});
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.terminal.close — pick a session and close it
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.terminal.close', async () => {
			const terminals = manager.listTerminals();
			if (terminals.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t('No terminal sessions.'),
				);
				return;
			}

			const items = terminals.map((t) => ({
				label: t.name,
				description: t.isActive ? 'active' : 'inactive',
				detail: `${t.id} · host ${t.hostId}`,
				terminal: t,
			}));

			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: vscode.l10n.t('Select a session to close'),
			});
			if (picked === undefined) {
				return;
			}

			manager.closeTerminal(picked.terminal.id);
			vscode.window.showInformationMessage(
				vscode.l10n.t('Closed terminal {0}', picked.terminal.name),
			);
		}),
	);

	return disposables;
}
