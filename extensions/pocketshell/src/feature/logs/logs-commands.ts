/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { LogsClient } from '../../backend/integrations/logs';
import type { LogEntry } from '../../backend/integrations/logs';
import { buildLogsPanelModel, renderLogsPanelHtml } from '../../backend/ui/logs';
import type { FeatureDeps } from '../manifest';

/** Maximum lines retained in the panel DOM (head bound). */
const MAX_LOG_ENTRIES = 500;

interface LogsPanelEntry {
	panel: vscode.WebviewPanel;
	nonce: string;
	hostId: number;
	logs: LogsClient;
	/** Accumulated entries this session (before bounding). */
	entries: LogEntry[];
	/** Total entries seen (carried across renders for the footer counter). */
	totalSeen: number;
	/** Count dropped from the head to honour MAX_LOG_ENTRIES. */
	dropped: number;
	/** Active tail stop function, when tailing. */
	stopTail?: () => void;
}

/**
 * Logs feature: registers read / tail / clear commands that drive the
 * remote `LogsClient` over an SSH connection.
 *
 * The primary surface is a rich WebviewPanel (`pocketshell.logs.openPanel`)
 * that renders a bounded streaming tail of the remote `pocketshell logs`
 * trace stream with auto-scroll and an explicit Clear. The legacy
 * OutputChannel dump (show/tail/clear) is preserved.
 */
export function registerLogs(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Logs');
	disposables.push(output);

	// One rich panel per hostId.
	const panels = new Map<number, LogsPanelEntry>();

	disposables.push(
		vscode.commands.registerCommand('pocketshell.logs.openPanel', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
			if (hostId === undefined || hostId === null) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}
			await openLogsPanel(service, panels, disposables, deps, hostId, new LogsClient(conn));
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.logs.show — read: fetch and render log entries (legacy)
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.logs.show', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined || hostId === null) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			try {
				const entries = await new LogsClient(conn).getLogs();
				renderLogs(output, entries);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Logs show failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.logs.tail — read: stream new entries for 30s (read-only)
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.logs.tail', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined || hostId === null) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			try {
				const stop = await new LogsClient(conn).tail((entry) => {
					renderEntry(output, entry);
				});
				output.show(true);
				vscode.window.showInformationMessage(
					vscode.l10n.t('Tailing logs (will stop in 30s)'),
				);
				// Read-only command: do not call deps.refreshTrees().
				setTimeout(() => stop(), 30_000);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Logs tail failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.logs.clear — mutate: clear remote logs, then refresh trees
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.logs.clear', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined || hostId === null) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const confirmed = await vscode.window.showWarningMessage(
				vscode.l10n.t('Clear all remote logs?'),
				{ modal: true },
				vscode.l10n.t('Clear'),
			);
			if (confirmed === undefined) {
				return;
			}

			try {
				await new LogsClient(conn).clear();
				output.clear();
				deps.refreshTrees();
				vscode.window.showInformationMessage(
					vscode.l10n.t('Logs cleared'),
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Logs clear failed: {0}', String(err)),
				);
			}
		}),
	);

	// Clean up all open logs panels on extension dispose.
	disposables.push({
		dispose: () => {
			for (const entry of panels.values()) {
				entry.stopTail?.();
				entry.panel.dispose();
			}
			panels.clear();
		},
	});

	return disposables;
}

async function openLogsPanel(
	service: ConnectionService,
	panels: Map<number, LogsPanelEntry>,
	_disposables: vscode.Disposable[],
	deps: FeatureDeps,
	hostId: number,
	logs: LogsClient,
): Promise<void> {
	let entry = panels.get(hostId);
	if (!entry) {
		const host = await service.getHost(hostId);
		const hostName = host?.name || host?.hostname || `Host ${hostId}`;
		const panel = vscode.window.createWebviewPanel(
			'pocketshell.logs',
			vscode.l10n.t('Logs: {0}', hostName),
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
			logs,
			entries: [],
			totalSeen: 0,
			dropped: 0,
		};
		panels.set(hostId, entry);

		// Lesson #20: push webview subscriptions into a Disposable[] and
		// dispose them in onDidDispose. NEVER pass the panel as Event's 3rd arg.
		const webviewDisposables: vscode.Disposable[] = [];
		webviewDisposables.push(
			panel.webview.onDidReceiveMessage(async (message: LogsPanelMessage) => {
				await handleLogsPanelMessage(message, service, deps, entry!);
			}),
		);
		panel.onDidDispose(() => {
			for (const d of webviewDisposables) {
				d.dispose();
			}
			entry?.stopTail?.();
			panels.delete(hostId);
		});
	}

	// SWR: render whatever we have immediately, then fetch a fresh batch.
	await renderLogsPanel(service, entry);
	entry.panel.reveal(vscode.ViewColumn.Active, true);
	void refreshLogsBatch(service, entry);
}

async function refreshLogsBatch(
	service: ConnectionService,
	entry: LogsPanelEntry,
): Promise<void> {
	let entries: LogEntry[] = [];
	let listError: string | undefined;
	try {
		entries = await entry.logs.getLogs();
	} catch (err) {
		listError = String(err);
	}
	// Replace the local buffer with the fresh batch (show semantics).
	entry.entries = entries;
	entry.totalSeen = entries.length;
	entry.dropped = 0;
	await renderLogsPanel(service, entry, listError
		? { tone: 'error', message: `Failed to load logs: ${listError}` }
		: undefined);
}

async function renderLogsPanel(
	service: ConnectionService,
	entry: LogsPanelEntry,
	status?: { tone: 'success' | 'error' | 'warning' | 'info' | undefined; message?: string },
): Promise<void> {
	const host = await service.getHost(entry.hostId);
	const hostName = host?.name || host?.hostname || `Host ${entry.hostId}`;
	const connected = service.getConnection(entry.hostId) !== null;

	const model = buildLogsPanelModel({
		hostName,
		entries: entry.entries,
		maxEntries: MAX_LOG_ENTRIES,
		connected,
		tailing: entry.stopTail !== undefined,
		previousDropped: entry.dropped,
		previousTotalSeen: entry.totalSeen,
		status: status?.tone && status.message
			? { tone: status.tone, message: status.message }
			: undefined,
	});

	entry.panel.title = vscode.l10n.t('Logs: {0}', hostName);
	entry.panel.webview.html = renderLogsPanelHtml(model, {
		cspSource: entry.panel.webview.cspSource,
		nonce: entry.nonce,
	});
}

interface LogsPanelMessage {
	action?: 'refresh' | 'tail' | 'clear';
}

async function handleLogsPanelMessage(
	message: LogsPanelMessage,
	service: ConnectionService,
	deps: FeatureDeps,
	entry: LogsPanelEntry,
): Promise<void> {
	const { action } = message;
	if (!action) {
		return;
	}
	try {
		if (action === 'refresh') {
			await refreshLogsBatch(service, entry);
			return;
		}
		if (action === 'tail') {
			if (entry.stopTail) {
				// Stop the active tail.
				entry.stopTail();
				entry.stopTail = undefined;
				await renderLogsPanel(service, entry, { tone: 'info', message: 'Stopped tailing' });
				return;
			}
			// Start a bounded tail: accumulate new entries into the buffer and
			// re-render. The buffer is bounded at render time by MAX_LOG_ENTRIES.
			const stop = await entry.logs.tail((line) => {
				entry.entries.push(line);
				entry.totalSeen += 1;
				// Drop the head when over capacity; the render also bounds, but
				// we trim the source array so memory does not grow unbounded.
				if (entry.entries.length > MAX_LOG_ENTRIES) {
					const overflow = entry.entries.length - MAX_LOG_ENTRIES;
					entry.entries.splice(0, overflow);
					entry.dropped += overflow;
				}
			});
			entry.stopTail = stop;
			await renderLogsPanel(service, entry, { tone: 'info', message: 'Tailing logs' });
			return;
		}
		if (action === 'clear') {
			await entry.logs.clear();
			entry.entries = [];
			entry.dropped = 0;
			entry.totalSeen = 0;
			deps.refreshTrees();
			await renderLogsPanel(service, entry, { tone: 'success', message: 'Cleared remote logs' });
			return;
		}
	} catch (err) {
		await renderLogsPanel(service, entry, { tone: 'error', message: errorMessage(err) });
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}

// -----------------------------------------------------------------------------
// Output rendering helpers (legacy)
// -----------------------------------------------------------------------------

/** Render a batch of LogEntry objects to the shared OutputChannel. */
function renderLogs(output: vscode.OutputChannel, entries: LogEntry[]): void {
	output.appendLine(`# pocketshell logs — ${entries.length} entry/entries`);
	for (const entry of entries) {
		renderEntry(output, entry);
	}
	output.appendLine('');
}

/** Render a single LogEntry to the shared OutputChannel. */
function renderEntry(output: vscode.OutputChannel, entry: LogEntry): void {
	const time = new Date(entry.timestamp).toISOString();
	const source = entry.source ? ` [${entry.source}]` : '';
	output.appendLine(`${time} ${entry.level.toUpperCase()}${source} ${entry.message}`);
}
