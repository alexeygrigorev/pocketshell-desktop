/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect, resolveTargetPath } from '../../host-picking';
import { EnvClient, envCopyDestinations, safeEnvValue } from '../../backend/integrations/env';
import type { EnvVar } from '../../backend/integrations/env';
import { buildEnvPanelModel, renderEnvPanelHtml } from '../../backend/ui/env';
import type { FeatureDeps } from '../manifest';

interface EnvPanelEntry {
	panel: vscode.WebviewPanel;
	nonce: string;
	hostId: number;
	scope: string;
	env: EnvClient;
}

/**
 * Env feature: registers list / set / unset commands that drive the
 * remote `EnvClient` over an SSH connection.
 *
 * The primary surface is a rich WebviewPanel (`pocketshell.env.openPanel`)
 * that mirrors the Android app's per-folder key/value table with masked
 * secrets, reveal-on-tap, and create/update/copy. The legacy OutputChannel
 * dump and QuickPick manage flow are preserved.
 */
export function registerEnv(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Env');
	disposables.push(output);

	// One rich panel per (hostId, scope) — reusing reveals it instead of
	// recreating, matching the Android app's per-folder navigation.
	const panels = new Map<string, EnvPanelEntry>();

	disposables.push(
		vscode.commands.registerCommand('pocketshell.env.openPanel', async (element?: unknown) => {
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
			await openEnvPanel(service, panels, disposables, deps, hostId, scope, env);
		}),
	);

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

	// Clean up all open env panels on extension dispose.
	disposables.push({
		dispose: () => {
			for (const entry of panels.values()) {
				entry.panel.dispose();
			}
			panels.clear();
		},
	});

	return disposables;
}

async function openEnvPanel(
	service: ConnectionService,
	panels: Map<string, EnvPanelEntry>,
	_disposables: vscode.Disposable[],
	deps: FeatureDeps,
	hostId: number,
	scope: string,
	env: EnvClient,
): Promise<void> {
	const key = `${hostId}:${scope}`;

	let entry = panels.get(key);
	if (!entry) {
		const panel = vscode.window.createWebviewPanel(
			'pocketshell.env',
			vscode.l10n.t('Env: {0}', scope),
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);
		entry = {
			panel,
			nonce: createNonce(),
			hostId,
			scope,
			env,
		};
		panels.set(key, entry);

		// Lesson #20: push webview subscriptions into a Disposable[] and
		// dispose them in onDidDispose. NEVER pass the panel as Event's 3rd arg.
		const webviewDisposables: vscode.Disposable[] = [];
		webviewDisposables.push(
			panel.webview.onDidReceiveMessage(async (message: EnvPanelMessage) => {
				await handleEnvPanelMessage(message, service, deps, entry!);
			}),
		);
		panel.onDidDispose(() => {
			for (const d of webviewDisposables) {
				d.dispose();
			}
			panels.delete(key);
		});
	}

	await renderEnvPanel(service, entry, { tone: undefined });
	entry.panel.reveal(vscode.ViewColumn.Active, true);
}

async function renderEnvPanel(
	service: ConnectionService,
	entry: EnvPanelEntry,
	status?: { tone: 'success' | 'error' | 'warning' | 'info' | undefined; message?: string },
): Promise<void> {
	let vars: EnvVar[] = [];
	let listError: string | undefined;
	try {
		vars = await entry.env.list(entry.scope);
	} catch (err) {
		listError = String(err);
	}
	const folders = await service.getWatchedFolders(entry.hostId);
	const host = await service.getHost(entry.hostId);
	const hostName = host?.name || host?.hostname || `Host ${entry.hostId}`;
	const connected = service.getConnection(entry.hostId) !== null;

	const model = buildEnvPanelModel({
		scope: entry.scope,
		hostName,
		vars,
		copyDestinations: folders,
		connected,
		loading: false,
		status: status?.tone && status.message
			? { tone: status.tone, message: status.message }
			: listError
				? { tone: 'error', message: `Failed to load env: ${listError}` }
				: undefined,
	});

	entry.panel.title = vscode.l10n.t('Env: {0}', entry.scope);
	entry.panel.webview.html = renderEnvPanelHtml(model, {
		cspSource: entry.panel.webview.cspSource,
		nonce: entry.nonce,
	});
}

interface EnvPanelMessage {
	action?: 'refresh' | 'set' | 'unset' | 'get' | 'copy';
	key?: string;
	value?: string;
	then?: string;
}

async function handleEnvPanelMessage(
	message: EnvPanelMessage,
	service: ConnectionService,
	deps: FeatureDeps,
	entry: EnvPanelEntry,
): Promise<void> {
	const { action } = message;
	if (!action) {
		return;
	}
	try {
		if (action === 'refresh') {
			await renderEnvPanel(service, entry);
			return;
		}
		if (action === 'set') {
			if (!message.key) {
				throw new Error('Missing variable name');
			}
			const value = message.value ?? '';
			await entry.env.set(message.key, value, entry.scope);
			deps.refreshTrees();
			await renderEnvPanel(service, entry, { tone: 'success', message: `Set ${message.key}` });
			return;
		}
		if (action === 'unset') {
			if (!message.key) {
				throw new Error('Missing variable name');
			}
			await entry.env.unset(message.key, entry.scope);
			deps.refreshTrees();
			await renderEnvPanel(service, entry, { tone: 'success', message: `Unset ${message.key}` });
			return;
		}
		if (action === 'get') {
			if (!message.key) {
				throw new Error('Missing variable name');
			}
			const value = await entry.env.get(message.key, entry.scope);
			if (message.then === 'copy') {
				if (value === undefined) {
					throw new Error(`No value for ${message.key}`);
				}
				await vscode.env.clipboard.writeText(value);
				await renderEnvPanel(service, entry, { tone: 'success', message: `Copied ${message.key}` });
			} else if (value !== undefined) {
				// Reveal the unmasked value in the webview (secrets only; non-secrets are already shown).
				entry.panel.webview.postMessage({ action: 'revealed', key: message.key, value });
			}
			return;
		}
		if (action === 'copy') {
			await copyEnvToKnownFolderViaPanel(service, entry, deps);
			return;
		}
	} catch (err) {
		await renderEnvPanel(service, entry, { tone: 'error', message: errorMessage(err) });
	}
}

async function copyEnvToKnownFolderViaPanel(
	service: ConnectionService,
	entry: EnvPanelEntry,
	deps: FeatureDeps,
): Promise<void> {
	const vars = await entry.env.list(entry.scope);
	if (vars.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('No environment variables set'));
		return;
	}
	const folders = await service.getWatchedFolders(entry.hostId);
	const destinations = envCopyDestinations(folders, entry.scope);
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
	const result = await entry.env.copy(
		entry.scope,
		destination.folder.path,
		selected.map((item: { label: string }) => item.label),
	);
	deps.refreshTrees();
	await renderEnvPanel(service, entry, {
		tone: 'success',
		message: `Copied ${result.copied.length} entr${result.copied.length === 1 ? 'y' : 'ies'} to ${destination.folder.label}`,
	});
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
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
