/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { UsageClient } from '../../backend/integrations/usage';
import type { ProviderUsage } from '../../backend/integrations/usage';
import {
	buildUsagePanelState,
	buildUsagePanelHtmlModel,
	renderUsagePanelHtml,
	renderUsagePanelState,
	type UsageHostSnapshot,
	type UsagePanelHost,
} from '../../backend/ui/usage';
import type { FeatureDeps } from '../manifest';

const DEFAULT_STALE_AFTER_MS = 60_000;

interface UsagePanelEntry {
	panel: vscode.WebviewPanel;
	nonce: string;
	focusHostId?: number;
}

/**
 * Usage feature: registers read commands that drive the remote `UsageClient`
 * over existing SSH connections and render a refreshable all-host panel.
 *
 * The primary surface is a rich WebviewPanel (`pocketshell.usage.openPanel`)
 * that mirrors the Android app's per-provider card layout. The legacy
 * OutputChannel dump is preserved on `pocketshell.usage.output` for users
 * who want plain text.
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

	// Singleton rich panel — one instance across all hosts, like the app's
	// dashboard strip + per-provider cards. Reused across commands.
	let panelEntry: UsagePanelEntry | undefined;

	disposables.push(
		vscode.commands.registerCommand('pocketshell.usage.openPanel', async (element?: unknown) => {
			const focusHostId = await resolveHostId(service, element, { connectedOnly: false });
			await openPanel(service, () => panelEntry, (entry) => {
				panelEntry = entry;
			}, disposables, snapshots, refreshing, focusHostId);
		}),
	);

	// Promoted: `pocketshell.usage.panel` now opens the rich panel (was: OutputChannel dump).
	disposables.push(
		vscode.commands.registerCommand('pocketshell.usage.panel', async () => {
			await openPanel(service, () => panelEntry, (entry) => {
				panelEntry = entry;
			}, disposables, snapshots, refreshing);
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.usage.refresh', async () => {
			await refreshConnectedHosts(service, snapshots, refreshing);
			if (panelEntry) {
				await renderRichPanel(service, panelEntry, snapshots, refreshing);
			} else {
				await renderOutputPanel(service, output, snapshots, refreshing);
			}
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
			await openPanel(service, () => panelEntry, (entry) => {
				panelEntry = entry;
			}, disposables, snapshots, refreshing, hostId);
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.usage.output', async () => {
			await refreshConnectedHosts(service, snapshots, refreshing);
			await renderOutputPanel(service, output, snapshots, refreshing);
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

async function openPanel(
	service: ConnectionService,
	getEntry: () => UsagePanelEntry | undefined,
	setEntry: (entry: UsagePanelEntry | undefined) => void,
	disposables: vscode.Disposable[],
	snapshots: Map<number, UsageHostSnapshot>,
	refreshing: Set<number>,
	focusHostId?: number,
): Promise<void> {
	let entry = getEntry();
	if (!entry) {
		const panel = vscode.window.createWebviewPanel(
			'pocketshell.usage',
			vscode.l10n.t('PocketShell Usage'),
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);
		entry = {
			panel,
			nonce: createNonce(),
		};
		setEntry(entry);

		// Lesson #20: capture each webview subscription and dispose on close.
		// The 3rd arg of Event<T> is a Disposable[] to PUSH INTO — never pass
		// the WebviewPanel/View itself. We push the webview message listener
		// into a local array and dispose it in onDidDispose.
		const webviewDisposables: vscode.Disposable[] = [];
		webviewDisposables.push(
			panel.webview.onDidReceiveMessage(async (message: { action?: string }) => {
				if (message?.action === 'refresh') {
					await refreshConnectedHosts(service, snapshots, refreshing);
					const current = getEntry();
					if (current) {
						await renderRichPanel(service, current, snapshots, refreshing);
					}
				}
			}),
		);
		panel.onDidDispose(() => {
			for (const d of webviewDisposables) {
				d.dispose();
			}
			setEntry(undefined);
		});
	}

	if (focusHostId !== undefined) {
		entry.focusHostId = focusHostId;
	}

	// Stale-while-revalidate: render cached snapshots instantly, then refresh.
	await renderRichPanel(service, entry, snapshots, refreshing);
	entry.panel.reveal(vscode.ViewColumn.Active, true);

	// Kick off a live refresh in the background; it will re-render when done.
	void refreshConnectedHosts(service, snapshots, refreshing).then(() => {
		const current = getEntry();
		if (current && current === entry) {
			void renderRichPanel(service, current, snapshots, refreshing);
		}
	});
}

async function renderRichPanel(
	service: ConnectionService,
	entry: UsagePanelEntry,
	snapshots: Map<number, UsageHostSnapshot>,
	refreshing: Set<number>,
): Promise<void> {
	const hosts = await service.getHosts();
	const connectionStates = new Map<number, string>();
	for (const host of hosts) {
		connectionStates.set(host.id, service.getState(host.id));
	}

	const state = buildUsagePanelState({
		hosts: hosts.map(toPanelHost),
		connectionStates,
		snapshots,
		refreshingHostIds: refreshing,
		now: Date.now(),
		staleAfterMs: DEFAULT_STALE_AFTER_MS,
	});
	const model = buildUsagePanelHtmlModel(state);
	entry.panel.webview.html = renderUsagePanelHtml(model, {
		cspSource: entry.panel.webview.cspSource,
		nonce: entry.nonce,
	});
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

async function renderOutputPanel(
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

function createNonce(): string {
	return randomBytes(16).toString('base64');
}
