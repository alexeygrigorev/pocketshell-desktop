/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { EnvClient } from '../../backend/integrations/env';
import type { EnvVar } from '../../backend/integrations/env';
import type { FeatureDeps } from '../manifest';

/**
 * Env feature: registers list / set / unset commands that drive the
 * remote `EnvClient` over an SSH connection.
 *
 * All three commands share the same host resolution. A single
 * `PocketShell Env` OutputChannel is reused across commands and disposed
 * together with the registered commands.
 */
export function registerEnv(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Env');
	disposables.push(output);

	// -------------------------------------------------------------------------
	// pocketshell.env.list — read: render environment variables
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.env.list', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			try {
				const vars = await new EnvClient(conn).list();
				renderVars(output, vars);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Env list failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.env.set — mutate: prompt key + value, then set
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.env.set', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const key = await vscode.window.showInputBox({
				prompt: 'Variable name',
			});
			if (key === undefined || key === null) {
				return;
			}

			const value = await vscode.window.showInputBox({
				prompt: 'Variable value',
			});
			if (value === undefined || value === null) {
				return;
			}

			try {
				await new EnvClient(conn).set(key, value);
				deps.refreshTrees();
				vscode.window.showInformationMessage(
					vscode.l10n.t('Set {0}', key),
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Env set failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.env.unset — mutate: list keys, pick, then unset
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.env.unset', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const env = new EnvClient(conn);
			let vars;
			try {
				vars = await env.list();
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Env list failed: {0}', String(err)),
				);
				return;
			}

			if (vars.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t('No environment variables set'),
				);
				return;
			}

			const picked = await vscode.window.showQuickPick(
				vars.map((v) => ({
					label: v.key,
					description: v.isSecret ? 'secret' : v.value,
				})),
				{ placeHolder: vscode.l10n.t('Select a variable to unset') },
			);
			if (picked === undefined) {
				return;
			}

			try {
				await env.unset(picked.label);
				deps.refreshTrees();
				vscode.window.showInformationMessage(
					vscode.l10n.t('Unset {0}', picked.label),
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Env unset failed: {0}', String(err)),
				);
			}
		}),
	);

	return disposables;
}

// -----------------------------------------------------------------------------
// Output rendering helpers
// -----------------------------------------------------------------------------

/** Render an EnvVar[] to the shared OutputChannel. */
function renderVars(
	output: vscode.OutputChannel,
	vars: EnvVar[],
): void {
	output.appendLine('# pocketshell env list');
	if (vars.length === 0) {
		output.appendLine('(no variables)');
		output.appendLine('');
		return;
	}
	for (const v of vars) {
		const shown = v.isSecret ? '***' : v.value;
		const desc = v.description ? `\t# ${v.description}` : '';
		output.appendLine(`${v.key}=${shown}${desc}`);
	}
	output.appendLine('');
}
