/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { JobsClient } from '../../backend/jobs';
import type { AgentJob } from '../../backend/jobs';
import { buildJobsPanelModel, renderJobsPanelHtml } from '../../backend/ui/jobs';
import type { FeatureDeps } from '../manifest';

interface JobsPanelEntry {
	panel: vscode.WebviewPanel;
	nonce: string;
	hostId: number;
	jobs: JobsClient;
}

/**
 * Jobs feature: registers list / logs / cancel commands that drive the
 * remote `JobsClient` over an SSH connection.
 *
 * The primary surface is a rich WebviewPanel (`pocketshell.jobs.openPanel`)
 * that mirrors the Android app's RecurringJobs screen: a per-job row with a
 * status pill, schedule line, and cancel action. The legacy OutputChannel
 * dump (list/logs/cancel) is preserved for plain-text users.
 */
export function registerJobs(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Jobs');
	disposables.push(output);

	// One rich panel per hostId — reusing reveals it instead of recreating,
	// matching the Android app's per-session navigation.
	const panels = new Map<number, JobsPanelEntry>();

	disposables.push(
		vscode.commands.registerCommand('pocketshell.jobs.openPanel', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}
			await openJobsPanel(service, panels, disposables, deps, hostId, new JobsClient(conn));
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.jobs.list — read: render all agent jobs (legacy OutputChannel)
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.jobs.list', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			try {
				const jobs = await new JobsClient(conn).list();
				renderJobs(output, hostId, jobs);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Jobs list failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.jobs.logs — read: fetch logs for a job id (legacy OutputChannel)
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.jobs.logs', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const jobId = await vscode.window.showInputBox({
				prompt: 'Job ID',
			});
			if (jobId === undefined) {
				return;
			}

			try {
				const logs = await new JobsClient(conn).logs(jobId);
				output.appendLine(`# jobs logs — ${jobId}`);
				output.appendLine(logs);
				output.appendLine('');
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Jobs logs failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.jobs.cancel — read+pick+mutate: list, pick, cancel, refresh
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.jobs.cancel', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const jobs = new JobsClient(conn);
			let list;
			try {
				list = await jobs.list();
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Jobs list failed: {0}', String(err)),
				);
				return;
			}

			if (list.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t('No jobs to cancel'),
				);
				return;
			}

			const picked = await vscode.window.showQuickPick(
				list.map((job) => ({
					label: job.id,
					description: job.status,
					detail: job.command,
				})),
				{ placeHolder: vscode.l10n.t('Select a job to cancel') },
			);
			if (picked === undefined) {
				return;
			}

			try {
				await jobs.cancel(picked.label);
				deps.refreshTrees();
				vscode.window.showInformationMessage(
					vscode.l10n.t('Cancelled job {0}', picked.label),
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Jobs cancel failed: {0}', String(err)),
				);
			}
		}),
	);

	// Clean up all open jobs panels on extension dispose.
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

async function openJobsPanel(
	service: ConnectionService,
	panels: Map<number, JobsPanelEntry>,
	_disposables: vscode.Disposable[],
	deps: FeatureDeps,
	hostId: number,
	jobs: JobsClient,
): Promise<void> {
	const host = await service.getHost(hostId);
	const hostName = host?.name || host?.hostname || `Host ${hostId}`;

	let entry = panels.get(hostId);
	if (!entry) {
		const panel = vscode.window.createWebviewPanel(
			'pocketshell.jobs',
			vscode.l10n.t('Jobs: {0}', hostName),
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
			jobs,
		};
		panels.set(hostId, entry);

		// Lesson #20: push webview subscriptions into a Disposable[] and
		// dispose them in onDidDispose. NEVER pass the panel as Event's 3rd arg.
		const webviewDisposables: vscode.Disposable[] = [];
		webviewDisposables.push(
			panel.webview.onDidReceiveMessage(async (message: JobsPanelMessage) => {
				await handleJobsPanelMessage(message, service, deps, entry!);
			}),
		);
		panel.onDidDispose(() => {
			for (const d of webviewDisposables) {
				d.dispose();
			}
			panels.delete(hostId);
		});
	}

	await renderJobsPanel(service, entry);
	entry.panel.reveal(vscode.ViewColumn.Active, true);
}

async function renderJobsPanel(
	service: ConnectionService,
	entry: JobsPanelEntry,
	status?: { tone: 'success' | 'error' | 'warning' | 'info' | undefined; message?: string },
): Promise<void> {
	let jobs: AgentJob[] = [];
	let listError: string | undefined;
	try {
		jobs = await entry.jobs.list();
	} catch (err) {
		listError = String(err);
	}
	const host = await service.getHost(entry.hostId);
	const hostName = host?.name || host?.hostname || `Host ${entry.hostId}`;
	const connected = service.getConnection(entry.hostId) !== null;

	const model = buildJobsPanelModel({
		hostName,
		jobs,
		connected,
		loading: false,
		status: status?.tone && status.message
			? { tone: status.tone, message: status.message }
			: listError
				? { tone: 'error', message: `Failed to load jobs: ${listError}` }
				: undefined,
	});

	entry.panel.title = vscode.l10n.t('Jobs: {0}', hostName);
	entry.panel.webview.html = renderJobsPanelHtml(model, {
		cspSource: entry.panel.webview.cspSource,
		nonce: entry.nonce,
	});
}

interface JobsPanelMessage {
	action?: 'refresh' | 'cancel' | 'logs';
	jobId?: string;
}

async function handleJobsPanelMessage(
	message: JobsPanelMessage,
	service: ConnectionService,
	deps: FeatureDeps,
	entry: JobsPanelEntry,
): Promise<void> {
	const { action } = message;
	if (!action) {
		return;
	}
	try {
		if (action === 'refresh') {
			await renderJobsPanel(service, entry);
			return;
		}
		if (action === 'cancel') {
			if (!message.jobId) {
				throw new Error('Missing job id');
			}
			await entry.jobs.cancel(message.jobId);
			deps.refreshTrees();
			await renderJobsPanel(service, entry, { tone: 'success', message: `Cancelled job ${message.jobId}` });
			return;
		}
		if (action === 'logs') {
			if (!message.jobId) {
				throw new Error('Missing job id');
			}
			const logs = await entry.jobs.logs(message.jobId);
			await renderJobsPanel(service, entry, {
				tone: 'info',
				message: logs.split('\n').slice(0, 4).join(' / ') || `No output for job ${message.jobId}`,
			});
			return;
		}
	} catch (err) {
		await renderJobsPanel(service, entry, { tone: 'error', message: errorMessage(err) });
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}

// -----------------------------------------------------------------------------
// Output rendering helpers
// -----------------------------------------------------------------------------

/** Render an AgentJob[] to the shared OutputChannel. */
function renderJobs(
	output: vscode.OutputChannel,
	hostId: number,
	jobs: AgentJob[],
): void {
	output.appendLine(`# jobs list — host ${hostId}`);
	output.appendLine(`${jobs.length} job(s)`);
	if (jobs.length > 0) {
		output.appendLine('');
		for (const job of jobs) {
			output.appendLine(
				`  ${job.id}  [${job.status}]  (${job.agentType})  ${job.command}`,
			);
		}
	}
	output.appendLine('');
}
