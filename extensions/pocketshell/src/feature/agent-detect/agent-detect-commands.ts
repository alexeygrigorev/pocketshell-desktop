/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { AgentDetector } from '../../backend/agents';
import type { DetectedAgent } from '../../backend/agents';
import type { FeatureDeps } from '../manifest';

/**
 * Agent-detect feature: registers commands that drive the remote
 * `AgentDetector` over an SSH connection.
 *
 * `detect` runs detection against a connected host and renders the results
 * to a shared `PocketShell Agent` OutputChannel. `showDetected` re-displays
 * the most recent results without re-probing the host.
 *
 * A single OutputChannel is reused across commands and disposed together
 * with the registered commands.
 */
export function registerAgentDetect(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Agent');
	disposables.push(output);

	// Most recent detection results, kept so `showDetected` can re-render
	// without re-probing the host.
	let lastDetected: DetectedAgent[] | undefined;

	// -------------------------------------------------------------------------
	// pocketshell.agent.detect — read: probe the host for installed agents
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.agent.detect', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const host = await service.getHost(hostId);
			const label = host?.name || host?.hostname || 'host';

			try {
				const detected = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: vscode.l10n.t('Detecting agents on {0}...', label),
						cancellable: false,
					},
					() => new AgentDetector(conn).detectAll(),
				);

				lastDetected = detected;
				renderDetected(output, label, detected);
				output.show(true);

				const installed = detected.filter((a: DetectedAgent) => a.isInstalled);
				if (installed.length === 0) {
					vscode.window.showWarningMessage(
						vscode.l10n.t('No AI agents detected on {0}', label),
					);
				} else {
					vscode.window.showInformationMessage(
						vscode.l10n.t(
							'Detected {0} agent(s) on {1}: {2}',
							String(installed.length),
							label,
							installed.map((a: DetectedAgent) => a.name).join(', '),
						),
					);
				}
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Agent detection failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.agent.showDetected — read: re-render the last results
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.agent.showDetected', async () => {
			if (lastDetected === undefined) {
				vscode.window.showInformationMessage(
					vscode.l10n.t('No agents detected yet. Run "Agent: Detect on Host" first.'),
				);
				return;
			}
			renderDetected(output, '(last result)', lastDetected);
			output.show(true);
		}),
	);

	return disposables;
}

// -----------------------------------------------------------------------------
// Output rendering helpers
// -----------------------------------------------------------------------------

/** Render a DetectedAgent[] to the shared OutputChannel. */
function renderDetected(
	output: vscode.OutputChannel,
	label: string,
	detected: DetectedAgent[],
): void {
	output.appendLine(`# agent detection — ${label}`);
	output.appendLine(`detectedAt: ${new Date().toISOString()}`);
	output.appendLine('');

	if (detected.length === 0) {
		output.appendLine('(no agents probed)');
		output.appendLine('');
		return;
	}

	for (const agent of detected) {
		if (agent.isInstalled) {
			output.appendLine(
				`  [x] ${agent.name}${agent.version ? ` ${agent.version}` : ''}`,
			);
			if (agent.binaryPath) {
				output.appendLine(`      path: ${agent.binaryPath}`);
			}
		} else {
			output.appendLine(`  [ ] ${agent.name} (not installed)`);
		}
	}
	output.appendLine('');
}
