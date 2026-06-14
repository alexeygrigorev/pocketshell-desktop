/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { HookManager, HookType } from '../../backend/agents/hooks';
import type { AgentType, HookConfig } from '../../backend/agents/hooks';
import type { FeatureDeps } from '../manifest';

/**
 * Hooks feature: registers read / pick / mutate commands that drive the
 * remote `HookManager` over an SSH connection.
 *
 * All four commands share the same host + repo-path resolution. A single
 * `PocketShell Hooks` OutputChannel is reused across commands and disposed
 * together with the registered commands.
 */
export function registerHooks(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Hooks');
	disposables.push(output);

	// -------------------------------------------------------------------------
	// pocketshell.hooks.status — read: render hook installation status
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.hooks.status', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const repoPath = await vscode.window.showInputBox({
				prompt: 'Repository path',
				value: '/home/',
			});
			if (repoPath === undefined) {
				return;
			}

			try {
				const config = await new HookManager(conn).status(repoPath);
				renderStatus(output, config);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Hooks status failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.hooks.list — read+pick: pick an installed hook to inspect
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.hooks.list', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const repoPath = await vscode.window.showInputBox({
				prompt: 'Repository path',
				value: '/home/',
			});
			if (repoPath === undefined) {
				return;
			}

			let config: HookConfig;
			try {
				config = await new HookManager(conn).status(repoPath);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Hooks list failed: {0}', String(err)),
				);
				return;
			}

			const picked = await vscode.window.showQuickPick(
				config.hooks.map((h) => ({
					label: `${h.type} (${h.agentType})`,
					description: h.isEnabled ? 'enabled' : h.status,
					detail: h.scriptPath,
					hook: h,
				})),
				{ placeHolder: vscode.l10n.t('Select a hook to inspect') },
			);
			if (picked === undefined) {
				return;
			}

			renderStatus(output, config);
			output.show(true);
			vscode.window.showInformationMessage(
				vscode.l10n.t('{0}: {1}', picked.label, picked.hook.status),
			);
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.hooks.add — mutate: install a hook for an agent type
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.hooks.add', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const repoPath = await vscode.window.showInputBox({
				prompt: 'Repository path',
				value: '/home/',
			});
			if (repoPath === undefined) {
				return;
			}

			const hookType = await pickHookType();
			if (hookType === undefined) {
				return;
			}

			const agentType = await pickAgentType();
			if (agentType === undefined) {
				return;
			}

			try {
				await new HookManager(conn).install(repoPath, hookType, agentType);
				deps.refreshTrees();
				vscode.window.showInformationMessage(
					vscode.l10n.t('Installed {0} hook for {1}', hookType, agentType),
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Hooks add failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.hooks.remove — mutate: uninstall a hook, then refresh trees
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.hooks.remove', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const repoPath = await vscode.window.showInputBox({
				prompt: 'Repository path',
				value: '/home/',
			});
			if (repoPath === undefined) {
				return;
			}

			const hookType = await pickHookType();
			if (hookType === undefined) {
				return;
			}

			try {
				await new HookManager(conn).uninstall(repoPath, hookType);
				deps.refreshTrees();
				vscode.window.showInformationMessage(
					vscode.l10n.t('Removed {0} hook', hookType),
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Hooks remove failed: {0}', String(err)),
				);
			}
		}),
	);

	return disposables;
}

// -----------------------------------------------------------------------------
// Quick-pick helpers
// -----------------------------------------------------------------------------

/** Quick-pick a git hook type. Returns undefined if cancelled. */
async function pickHookType(): Promise<HookType | undefined> {
	const items = (Object.values(HookType) as HookType[]).map((type) => ({
		label: type,
		hookType: type,
	}));
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: vscode.l10n.t('Select a hook type'),
	});
	return picked?.hookType;
}

/** Quick-pick a supported agent type. Returns undefined if cancelled. */
async function pickAgentType(): Promise<AgentType | undefined> {
	const agents: AgentType[] = ['claude', 'codex', 'opencode'];
	const picked = await vscode.window.showQuickPick(agents, {
		placeHolder: vscode.l10n.t('Select an agent type'),
	});
	return picked as AgentType | undefined;
}

// -----------------------------------------------------------------------------
// Output rendering helpers
// -----------------------------------------------------------------------------

/** Render a HookConfig to the shared OutputChannel. */
function renderStatus(
	output: vscode.OutputChannel,
	config: HookConfig,
): void {
	output.appendLine(`# hooks status — ${config.repoPath}`);
	if (config.hooks.length === 0) {
		output.appendLine('(no hooks)');
		output.appendLine('');
		return;
	}
	for (const h of config.hooks) {
		const flag = h.isEnabled ? 'enabled' : `disabled (${h.status})`;
		output.appendLine(`  ${h.type} [${h.agentType}]: ${flag}`);
		if (h.scriptPath) {
			output.appendLine(`    ${h.scriptPath}`);
		}
	}
	output.appendLine('');
}
