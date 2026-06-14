/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { BootstrapManager } from '../../backend/integrations/bootstrap';
import type { PocketshellStatus } from '../../backend/integrations/bootstrap';
import type { FeatureDeps } from '../manifest';

/**
 * Bootstrap feature: registers status / install / upgrade commands that drive
 * the remote `BootstrapManager` over an SSH connection to manage the
 * pocketshell utility on the host.
 *
 * All three commands share the same host resolution. A single
 * `PocketShell Bootstrap` OutputChannel is reused across commands and disposed
 * together with the registered commands.
 */
export function registerBootstrap(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Bootstrap');
	disposables.push(output);

	// -------------------------------------------------------------------------
	// pocketshell.bootstrap.status — read: detect install + update availability
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.bootstrap.status', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined || hostId === null) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null || conn === undefined) {
				return;
			}

			try {
				const status = await new BootstrapManager(conn).detect();
				renderStatus(output, status);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Bootstrap status failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.bootstrap.install — mutate: install pocketshell, refresh trees
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.bootstrap.install', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined || hostId === null) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null || conn === undefined) {
				return;
			}

			const confirm = await vscode.window.showWarningMessage(
				vscode.l10n.t('Install pocketshell on this host?'),
				{ modal: true },
				vscode.l10n.t('Install'),
			);
			if (confirm === undefined) {
				return;
			}

			try {
				const result = await new BootstrapManager(conn).install();
				if (result.success) {
					deps.refreshTrees();
					vscode.window.showInformationMessage(
						vscode.l10n.t('Pocketshell installed{0}', result.version ? ` (v${result.version})` : ''),
					);
				} else {
					vscode.window.showErrorMessage(
						vscode.l10n.t('Bootstrap install failed: {0}', result.error ?? 'unknown error'),
					);
				}
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Bootstrap install failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.bootstrap.upgrade — mutate: upgrade pocketshell, refresh trees
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.bootstrap.upgrade', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined || hostId === null) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null || conn === undefined) {
				return;
			}

			const confirm = await vscode.window.showWarningMessage(
				vscode.l10n.t('Upgrade pocketshell on this host?'),
				{ modal: true },
				vscode.l10n.t('Upgrade'),
			);
			if (confirm === undefined) {
				return;
			}

			try {
				const result = await new BootstrapManager(conn).upgrade();
				if (result.success) {
					deps.refreshTrees();
					vscode.window.showInformationMessage(
						vscode.l10n.t(
							'Pocketshell upgraded{0}',
							result.newVersion ? ` to v${result.newVersion}` : '',
						),
					);
				} else {
					vscode.window.showErrorMessage(
						vscode.l10n.t('Bootstrap upgrade failed: {0}', result.error ?? 'unknown error'),
					);
				}
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Bootstrap upgrade failed: {0}', String(err)),
				);
			}
		}),
	);

	return disposables;
}

// -----------------------------------------------------------------------------
// Output rendering helpers
// -----------------------------------------------------------------------------

/** Render a PocketshellStatus to the shared OutputChannel. */
function renderStatus(
	output: vscode.OutputChannel,
	status: PocketshellStatus,
): void {
	output.appendLine('# pocketshell bootstrap — status');
	if (!status.isInstalled) {
		output.appendLine('not installed');
		if (status.latestVersion && status.latestVersion !== '0.0.0') {
			output.appendLine(`latest version available: ${status.latestVersion}`);
		}
	} else {
		output.appendLine(`installed: v${status.version ?? 'unknown'}`);
		if (status.binaryPath) {
			output.appendLine(`path: ${status.binaryPath}`);
		}
		output.appendLine(status.needsUpdate ? 'update available' : 'up to date');
		if (status.latestVersion && status.latestVersion !== '0.0.0') {
			output.appendLine(`latest version: ${status.latestVersion}`);
		}
	}
	output.appendLine('');
}
