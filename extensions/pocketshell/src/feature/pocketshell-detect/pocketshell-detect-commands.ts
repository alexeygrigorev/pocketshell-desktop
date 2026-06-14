/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { PocketshellAgentDetector } from '../../backend/agents/pocketshell-detector';
import type { DetectedAgent } from '../../backend/agents/types';
import type { FeatureDeps } from '../manifest';

/**
 * PocketShell-detect feature: drives `PocketshellAgentDetector` over an SSH
 * connection to discover AI coding agents (Claude / Codex / OpenCode) on the
 * remote host, render their status, and offer an install/upgrade hint.
 *
 * All three commands share the same host resolution and a single
 * `PocketShell Detect` OutputChannel disposed together with the commands.
 */
export function registerPocketshellDetect(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Detect');
	disposables.push(output);

	// -------------------------------------------------------------------------
	// pocketshell.pocketshell.detect — read: run detection, list agents
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.pocketshell.detect', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			try {
				const agents = await new PocketshellAgentDetector(conn).detect();
				renderAgents(output, hostId, agents);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('PocketShell detect failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.pocketshell.status — read: quick summary in a message
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.pocketshell.status', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			try {
				const agents = await new PocketshellAgentDetector(conn).detect();
				const installed = agents.filter((a) => a.isInstalled);
				if (installed.length === 0) {
					vscode.window.showWarningMessage(
						vscode.l10n.t('No PocketShell-managed agents detected on host {0}.', String(hostId)),
					);
					return;
				}
				vscode.window.showInformationMessage(
					vscode.l10n.t(
						'{0} agent(s) installed: {1}',
						String(installed.length),
						installed.map((a) => a.name).join(', '),
					),
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('PocketShell status failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.pocketshell.install — mutate: hint install/upgrade, refresh
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.pocketshell.install', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			try {
				const agents = await new PocketshellAgentDetector(conn).detect();
				const missing = agents.filter((a) => !a.isInstalled);
				renderAgents(output, hostId, agents);
				output.show(true);

				if (missing.length === 0) {
					vscode.window.showInformationMessage(
						vscode.l10n.t('All known agents already installed on host {0}.', String(hostId)),
					);
					return;
				}

				const install = await vscode.window.showInformationMessage(
					vscode.l10n.t(
						'{0} agent(s) not installed: {1}',
						String(missing.length),
						missing.map((a) => a.name).join(', '),
					),
					vscode.l10n.t('Open install guide'),
				);
				if (install) {
					vscode.env.openExternal(
						vscode.Uri.parse('https://github.com/anthropics/claude-code#installation'),
					);
				}
				_deps.refreshTrees();
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('PocketShell install/upgrade failed: {0}', String(err)),
				);
			}
		}),
	);

	return disposables;
}

// -----------------------------------------------------------------------------
// Output rendering helpers
// -----------------------------------------------------------------------------

/** Render a list of detected agents to the shared OutputChannel. */
function renderAgents(
	output: vscode.OutputChannel,
	hostId: number,
	agents: DetectedAgent[],
): void {
	output.appendLine(`# pocketshell detect — host ${hostId}`);
	const detectedAt = agents[0]?.detectedAt;
	if (detectedAt !== undefined) {
		output.appendLine(`detected at: ${new Date(detectedAt).toISOString()}`);
	}
	output.appendLine('');

	for (const a of agents) {
		const mark = a.isInstalled ? '[x]' : '[ ]';
		const version = a.version ? ` ${a.version}` : '';
		const path = a.binaryPath ? ` @ ${a.binaryPath}` : '';
		output.appendLine(`${mark} ${a.name}${version}${path}`);
	}
	output.appendLine('');
}
