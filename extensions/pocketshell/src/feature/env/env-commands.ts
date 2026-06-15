/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect, resolveTargetPath } from '../../host-picking';
import { EnvClient, envCopyDestinations, safeEnvValue } from '../../backend/integrations/env';
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
		vscode.commands.registerCommand('pocketshell.env.list', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const scope = resolveTargetPath(element);

			try {
				const vars = await new EnvClient(conn).list(scope);
				renderVars(output, vars, scope);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Env list failed: {0}', String(err)),
				);
			}
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.env.manage', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const scope = await resolveEnvScope(service, hostId, element);
			if (!scope) {
				return;
			}

			const env = new EnvClient(conn);
			await showEnvManager(env, output, deps, service, hostId, scope);
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.env.set — mutate: prompt key + value, then set
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.env.set', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const scope = await resolveEnvScope(service, hostId, element);
			if (!scope) {
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
				await new EnvClient(conn).set(key, value, scope);
				deps.refreshTrees();
				vscode.window.showInformationMessage(
					vscode.l10n.t('Set {0} for {1}', key, scope),
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
		vscode.commands.registerCommand('pocketshell.env.unset', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const scope = await resolveEnvScope(service, hostId, element);
			if (!scope) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const env = new EnvClient(conn);
			let vars;
			try {
				vars = await env.list(scope);
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
					description: safeEnvValue(v),
					detail: v.isSecret ? vscode.l10n.t('secret value hidden') : undefined,
				})),
				{ placeHolder: vscode.l10n.t('Select a variable to unset') },
			);
			if (picked === undefined) {
				return;
			}

			try {
				await env.unset(picked.label, scope);
				deps.refreshTrees();
				vscode.window.showInformationMessage(
					vscode.l10n.t('Unset {0} for {1}', picked.label, scope),
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

async function showEnvManager(
	env: EnvClient,
	output: vscode.OutputChannel,
	deps: FeatureDeps,
	service: ConnectionService,
	hostId: number,
	scope: string,
): Promise<void> {
	let vars: EnvVar[];
	try {
		vars = await env.list(scope);
	} catch (err) {
		vscode.window.showErrorMessage(
			vscode.l10n.t('Env list failed: {0}', String(err)),
		);
		return;
	}

	const picked = await vscode.window.showQuickPick(
		[
			...vars.map((v) => ({
				label: v.key,
				description: safeEnvValue(v),
				detail: v.isSecret ? vscode.l10n.t('secret value hidden') : undefined,
				action: 'view' as const,
			})),
			{ label: '$(add) Set entry', description: scope, action: 'set' as const },
			{ label: '$(trash) Unset entry', description: scope, action: 'unset' as const },
			{ label: '$(copy) Copy entries to folder', description: scope, action: 'copy' as const },
			{ label: '$(output) Show list in output', description: scope, action: 'list' as const },
		],
		{ placeHolder: vscode.l10n.t('Manage env for {0}', scope) },
	);
	if (!picked) {
		return;
	}

	if (picked.action === 'set') {
		await vscode.commands.executeCommand('pocketshell.env.set', { hostId, path: scope });
		return;
	}
	if (picked.action === 'unset') {
		await vscode.commands.executeCommand('pocketshell.env.unset', { hostId, path: scope });
		return;
	}
	if (picked.action === 'copy') {
		await copyEnvToKnownFolder(env, service, deps, hostId, scope, vars);
		return;
	}
	if (picked.action === 'list') {
		renderVars(output, vars, scope);
		output.show(true);
		return;
	}

	const entry = vars.find((v) => v.key === picked.label);
	if (entry) {
		vscode.window.showInformationMessage(`${entry.key}=${safeEnvValue(entry)}`);
	}
}

async function copyEnvToKnownFolder(
	env: EnvClient,
	service: ConnectionService,
	deps: FeatureDeps,
	hostId: number,
	sourceScope: string,
	vars: EnvVar[],
): Promise<void> {
	if (vars.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('No environment variables set'));
		return;
	}

	const folders = await service.getWatchedFolders(hostId);
	const destinations = envCopyDestinations(folders, sourceScope);
	if (destinations.length === 0) {
		vscode.window.showInformationMessage(
			vscode.l10n.t('No other watched folders are available.'),
		);
		return;
	}

	const destination = await vscode.window.showQuickPick(
		destinations.map((folder) => ({
			label: folder.label,
			description: folder.path,
			folder,
		})),
		{ placeHolder: vscode.l10n.t('Copy env entries to watched folder') },
	);
	if (!destination) {
		return;
	}

	const selected = await vscode.window.showQuickPick(
		vars.map((v) => ({
			label: v.key,
			description: safeEnvValue(v),
			picked: true,
		})),
		{
			canPickMany: true,
			placeHolder: vscode.l10n.t('Select env entries to copy'),
		},
	);
	if (!selected || selected.length === 0) {
		return;
	}

	try {
		const result = await env.copy(
			sourceScope,
			destination.folder.path,
			selected.map((item: { label: string }) => item.label),
		);
		deps.refreshTrees();
		vscode.window.showInformationMessage(
			vscode.l10n.t(
				'Copied {0} env entries to {1}',
				String(result.copied.length),
				destination.folder.label,
			),
		);
	} catch (err) {
		vscode.window.showErrorMessage(
			vscode.l10n.t('Env copy failed: {0}', String(err)),
		);
	}
}

async function resolveEnvScope(
	service: ConnectionService,
	hostId: number,
	element: unknown,
): Promise<string | undefined> {
	const targetPath = resolveTargetPath(element);
	if (targetPath) {
		return targetPath;
	}

	const folders = await service.getWatchedFolders(hostId);
	if (folders.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('No watched folders configured.'));
		return undefined;
	}

	const picked = await vscode.window.showQuickPick(
		folders
			.filter((folder) => folder.enabled)
			.map((folder) => ({
				label: folder.label,
				description: folder.path,
				folder,
			})),
		{ placeHolder: vscode.l10n.t('Select a watched folder') },
	);
	return picked?.folder.path;
}

// -----------------------------------------------------------------------------
// Output rendering helpers
// -----------------------------------------------------------------------------

/** Render an EnvVar[] to the shared OutputChannel. */
function renderVars(
	output: vscode.OutputChannel,
	vars: EnvVar[],
	scope?: string,
): void {
	output.appendLine(scope ? `# pocketshell env list — ${scope}` : '# pocketshell env list');
	if (vars.length === 0) {
		output.appendLine('(no variables)');
		output.appendLine('');
		return;
	}
	for (const v of vars) {
		const desc = v.description ? `\t# ${v.description}` : '';
		output.appendLine(`${v.key}=${safeEnvValue(v)}${desc}`);
	}
	output.appendLine('');
}
