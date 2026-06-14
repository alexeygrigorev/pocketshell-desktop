/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { UsageClient } from '../../backend/integrations/usage';
import type { UsageSummary, ProviderUsage } from '../../backend/integrations/usage';
import type { FeatureDeps } from '../manifest';

/**
 * Usage feature: registers read commands that drive the remote `UsageClient`
 * over an SSH connection to fetch AI provider usage/quota data.
 *
 * Both commands share the same host resolution. A single `PocketShell Usage`
 * OutputChannel is reused across commands and disposed together with the
 * registered commands.
 */
export function registerUsage(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Usage');
	disposables.push(output);

	// -------------------------------------------------------------------------
	// pocketshell.usage.show — read: render aggregate usage summary
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.usage.show', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			try {
				const summary = await new UsageClient(conn).getUsage();
				renderSummary(output, summary);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Usage show failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.usage.provider — read: render usage for a specific provider
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.usage.provider', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const provider = await vscode.window.showInputBox({
				prompt: 'Provider name',
				value: 'anthropic',
			});
			if (provider === undefined || provider === null) {
				return;
			}

			try {
				const usage = await new UsageClient(conn).getProviderUsage(provider);
				renderProvider(output, usage);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Usage by provider failed: {0}', String(err)),
				);
			}
		}),
	);

	return disposables;
}

// -----------------------------------------------------------------------------
// Output rendering helpers
// -----------------------------------------------------------------------------

/** Render a UsageSummary to the shared OutputChannel. */
function renderSummary(
	output: vscode.OutputChannel,
	summary: UsageSummary,
): void {
	output.appendLine('# pocketshell usage — summary');
	output.appendLine(
		`${summary.providers.length} provider(s), total ${summary.totalCostUsd.toFixed(2)} ${summary.currency}`,
	);

	for (const p of summary.providers) {
		output.appendLine('');
		renderProvider(output, p);
	}
	output.appendLine('');
}

/** Render a single ProviderUsage entry to the shared OutputChannel. */
function renderProvider(
	output: vscode.OutputChannel,
	usage: ProviderUsage,
): void {
	output.appendLine(`## ${usage.provider} — ${usage.period}`);
	output.appendLine(
		`tokens: ${usage.tokensUsed}/${usage.tokensLimit}`,
	);
	output.appendLine(
		`requests: ${usage.requestsUsed}/${usage.requestsLimit}`,
	);
	if (usage.costUsd !== undefined) {
		output.appendLine(`cost: ${usage.costUsd.toFixed(2)} USD`);
	}
}
