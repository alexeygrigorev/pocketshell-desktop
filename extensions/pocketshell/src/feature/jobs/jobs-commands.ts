/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { JobsClient } from '../../backend/jobs';
import type { AgentJob } from '../../backend/jobs';
import type { FeatureDeps } from '../manifest';

/**
 * Jobs feature: registers list / logs / cancel commands that drive the
 * remote `JobsClient` over an SSH connection.
 *
 * All three commands share the same host resolution. A single
 * `PocketShell Jobs` OutputChannel is reused across commands and disposed
 * together with the registered commands.
 */
export function registerJobs(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Jobs');
	disposables.push(output);

	// -------------------------------------------------------------------------
	// pocketshell.jobs.list — read: render all agent jobs
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
	// pocketshell.jobs.logs — read: fetch logs for a job id
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

	return disposables;
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
