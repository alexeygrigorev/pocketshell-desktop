/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import {
	BootstrapManager,
	MIN_POCKETSHELL_CLI_VERSION,
	isVersionCompatible,
} from '../../backend/integrations/bootstrap';
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
		vscode.commands.registerCommand('pocketshell.bootstrap.status', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
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

				// Surface a warning when the installed CLI is below the
				// required minimum, offering the existing "Upgrade CLI"
				// action (`pocketshell.bootstrap.upgrade`).
				if (status.isInstalled && status.version) {
					await warnIfBelowMinimum(hostId, status.version);
				}
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
		vscode.commands.registerCommand('pocketshell.bootstrap.install', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
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
		vscode.commands.registerCommand('pocketshell.bootstrap.upgrade', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
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
	output.appendLine(`required minimum: v${MIN_POCKETSHELL_CLI_VERSION}`);
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
		// Version-compatibility line vs. the declared minimum.
		if (status.version) {
			const compatible = isVersionCompatible(status.version, MIN_POCKETSHELL_CLI_VERSION);
			output.appendLine(
				compatible
					? `compatible with required minimum (>= ${MIN_POCKETSHELL_CLI_VERSION})`
					: `BELOW required minimum ${MIN_POCKETSHELL_CLI_VERSION} — use Upgrade CLI`,
			);
		}
	}
	output.appendLine('');
}

/**
 * Warn the user when the installed CLI is below the required minimum, offering
 * the existing "Upgrade CLI" action.
 *
 * Reuses the already-registered `pocketshell.bootstrap.upgrade` command by
 * invoking it through `vscode.commands.executeCommand` — no new commands are
 * added to the manifest or package.json. The `hostId` is forwarded so the
 * upgrade runs against the same host that was just probed.
 *
 * Returns silently (no warning) when the installed version meets the minimum.
 */
async function warnIfBelowMinimum(hostId: number, installedVersion: string): Promise<void> {
	if (isVersionCompatible(installedVersion, MIN_POCKETSHELL_CLI_VERSION)) {
		return;
	}

	const upgrade = vscode.l10n.t('Upgrade CLI');
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t(
			'PocketShell CLI {0} is below the required minimum {1}. The desktop may not work correctly with this CLI version.',
			installedVersion,
			MIN_POCKETSHELL_CLI_VERSION,
		),
		upgrade,
	);
	if (choice === upgrade) {
		await vscode.commands.executeCommand('pocketshell.bootstrap.upgrade', hostId);
	}
}
