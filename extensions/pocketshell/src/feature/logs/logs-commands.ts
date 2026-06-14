/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { LogsClient } from '../../backend/integrations/logs';
import type { LogEntry } from '../../backend/integrations/logs';
import type { FeatureDeps } from '../manifest';

/**
 * Logs feature: registers read / tail / clear commands that drive the
 * remote `LogsClient` over an SSH connection.
 *
 * All three commands share the same host resolution. A single
 * `PocketShell Logs` OutputChannel is reused across commands and disposed
 * together with the registered commands.
 */
export function registerLogs(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Logs');
	disposables.push(output);

	// -------------------------------------------------------------------------
	// pocketshell.logs.show — read: fetch and render log entries
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.logs.show', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined || hostId === null) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			try {
				const entries = await new LogsClient(conn).getLogs();
				renderLogs(output, entries);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Logs show failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.logs.tail — read: stream new entries for 30s (read-only)
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.logs.tail', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined || hostId === null) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			try {
				const stop = await new LogsClient(conn).tail((entry) => {
					renderEntry(output, entry);
				});
				output.show(true);
				vscode.window.showInformationMessage(
					vscode.l10n.t('Tailing logs (will stop in 30s)'),
				);
				// Read-only command: do not call deps.refreshTrees().
				setTimeout(() => stop(), 30_000);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Logs tail failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.logs.clear — mutate: clear remote logs, then refresh trees
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.logs.clear', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined || hostId === null) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const confirmed = await vscode.window.showWarningMessage(
				vscode.l10n.t('Clear all remote logs?'),
				{ modal: true },
				vscode.l10n.t('Clear'),
			);
			if (confirmed === undefined) {
				return;
			}

			try {
				await new LogsClient(conn).clear();
				output.clear();
				deps.refreshTrees();
				vscode.window.showInformationMessage(
					vscode.l10n.t('Logs cleared'),
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Logs clear failed: {0}', String(err)),
				);
			}
		}),
	);

	return disposables;
}

// -----------------------------------------------------------------------------
// Output rendering helpers
// -----------------------------------------------------------------------------

/** Render a batch of LogEntry objects to the shared OutputChannel. */
function renderLogs(output: vscode.OutputChannel, entries: LogEntry[]): void {
	output.appendLine(`# pocketshell logs — ${entries.length} entry/entries`);
	for (const entry of entries) {
		renderEntry(output, entry);
	}
	output.appendLine('');
}

/** Render a single LogEntry to the shared OutputChannel. */
function renderEntry(output: vscode.OutputChannel, entry: LogEntry): void {
	const time = new Date(entry.timestamp).toISOString();
	const source = entry.source ? ` [${entry.source}]` : '';
	output.appendLine(`${time} ${entry.level.toUpperCase()}${source} ${entry.message}`);
}
