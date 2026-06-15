/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { UsageClient } from '../../backend/integrations/usage';
import type { ProviderUsage } from '../../backend/integrations/usage';
import {
	buildUsagePanelState,
	renderUsagePanelState,
	type UsageHostSnapshot,
	type UsagePanelHost,
} from '../../backend/ui/usage';
import type { FeatureDeps } from '../manifest';

const DEFAULT_STALE_AFTER_MS = 60_000;

/**
 * Usage feature: registers read commands that drive the remote `UsageClient`
 * over existing SSH connections and render a refreshable all-host panel.
 */
export function registerUsage(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Usage');
	const snapshots = new Map<number, UsageHostSnapshot>();
	const refreshing = new Set<number>();
	disposables.push(output);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.usage.panel', async () => {
			await refreshConnectedHosts(service, snapshots, refreshing);
			await renderPanel(service, output, snapshots, refreshing);
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.usage.refresh', async () => {
			await refreshConnectedHosts(service, snapshots, refreshing);
			await renderPanel(service, output, snapshots, refreshing);
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.usage.show', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: false });
			if (hostId === undefined) {
				return;
			}
			if (service.getConnection(hostId) !== null) {
				await refreshHost(service, hostId, snapshots, refreshing);
			}
			await renderPanel(service, output, snapshots, refreshing, hostId);
		}),
	);

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
				output.clear();
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

async function refreshConnectedHosts(
	service: ConnectionService,
	snapshots: Map<number, UsageHostSnapshot>,
	refreshing: Set<number>,
): Promise<void> {
	const hosts = await service.getHosts();
	await Promise.all(
		hosts
			.filter((host) => service.getConnection(host.id) !== null)
			.map((host) => refreshHost(service, host.id, snapshots, refreshing)),
	);
}

async function refreshHost(
	service: ConnectionService,
	hostId: number,
	snapshots: Map<number, UsageHostSnapshot>,
	refreshing: Set<number>,
): Promise<void> {
	refreshing.add(hostId);
	try {
		const conn = await getOrConnect(service, hostId);
		if (conn === null) {
			snapshots.set(hostId, {
				errorText: 'No active SSH connection',
				lastRefreshAt: Date.now(),
			});
			return;
		}
		const summary = await new UsageClient(conn).getUsage();
		snapshots.set(hostId, {
			summary,
			lastRefreshAt: Date.now(),
		});
	} catch (err) {
		snapshots.set(hostId, {
			errorText: String(err),
			lastRefreshAt: Date.now(),
		});
	} finally {
		refreshing.delete(hostId);
	}
}

async function renderPanel(
	service: ConnectionService,
	output: vscode.OutputChannel,
	snapshots: Map<number, UsageHostSnapshot>,
	refreshing: Set<number>,
	hostId?: number,
): Promise<void> {
	const hosts = await service.getHosts();
	const selectedHosts = hostId === undefined
		? hosts
		: hosts.filter((host) => host.id === hostId);
	const connectionStates = new Map<number, string>();
	for (const host of selectedHosts) {
		connectionStates.set(host.id, service.getState(host.id));
	}

	const state = buildUsagePanelState({
		hosts: selectedHosts.map(toPanelHost),
		connectionStates,
		snapshots,
		refreshingHostIds: refreshing,
		now: Date.now(),
		staleAfterMs: DEFAULT_STALE_AFTER_MS,
	});

	output.clear();
	output.append(renderUsagePanelState(state));
	output.show(true);
}

function toPanelHost(host: {
	id: number;
	name: string;
	hostname: string;
	username: string;
	port: number;
	enabled?: boolean;
}): UsagePanelHost {
	return {
		id: host.id,
		name: host.name,
		hostname: host.hostname,
		username: host.username,
		port: host.port,
		enabled: host.enabled,
	};
}

/** Render a single ProviderUsage entry to the shared OutputChannel. */
function renderProvider(
	output: vscode.OutputChannel,
	usage: ProviderUsage,
): void {
	output.appendLine(`## ${usage.provider} - ${usage.period}`);
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
