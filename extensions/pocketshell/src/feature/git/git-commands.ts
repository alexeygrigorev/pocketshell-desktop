/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { GitClient } from '../../backend/git';
import type { GitStatus, GitPullResult } from '../../backend/git';
import type { FeatureDeps } from '../manifest';

/**
 * Git feature: registers read / pick / mutate commands that drive the
 * remote `GitClient` over an SSH connection.
 *
 * All three commands share the same host + repo-path resolution. A single
 * `PocketShell Git` OutputChannel is reused across commands and disposed
 * together with the registered commands.
 */
export function registerGit(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Git');
	disposables.push(output);

	// -------------------------------------------------------------------------
	// pocketshell.git.status — read: render working-tree status
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.git.status', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
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
				const status = await new GitClient(conn).status(repoPath);
				renderStatus(output, repoPath, status);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Git status failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.git.branches — read+pick+mutate: list branches, checkout
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.git.branches', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
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

			const git = new GitClient(conn);
			let branches;
			try {
				branches = await git.branches(repoPath);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Git branches failed: {0}', String(err)),
				);
				return;
			}

			const picked = await vscode.window.showQuickPick(
				branches.map((b) => ({
					label: b.name,
					description: b.isCurrent ? 'current' : '',
				})),
				{ placeHolder: vscode.l10n.t('Select a branch to checkout') },
			);
			if (picked === undefined) {
				return;
			}

			// No-op if the current branch was picked.
			const current = branches.find((b) => b.isCurrent);
			if (current && current.name === picked.label) {
				return;
			}

			try {
				await git.checkout(repoPath, picked.label);
				deps.refreshTrees();
				vscode.window.showInformationMessage(
					vscode.l10n.t('Checked out {0}', picked.label),
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Git checkout failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.git.pull — mutate: pull upstream, then refresh trees
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.git.pull', async () => {
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
				const result = await new GitClient(conn).pull(repoPath);
				renderPull(output, repoPath, result);
				output.show(true);
				deps.refreshTrees();
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Git pull failed: {0}', String(err)),
				);
			}
		}),
	);

	return disposables;
}

// -----------------------------------------------------------------------------
// Output rendering helpers
// -----------------------------------------------------------------------------

/** Render a GitStatus to the shared OutputChannel. */
function renderStatus(
	output: vscode.OutputChannel,
	repoPath: string,
	status: GitStatus,
): void {
	output.appendLine(`# git status — ${repoPath}`);
	output.appendLine(`branch: ${status.branch}`);
	if (status.ahead > 0 || status.behind > 0) {
		output.appendLine(`ahead ${status.ahead}, behind ${status.behind}`);
	}
	output.appendLine(
		status.isClean ? 'working tree clean' : 'working tree dirty',
	);

	if (status.staged.length > 0) {
		output.appendLine('');
		output.appendLine('## staged');
		for (const f of status.staged) {
			output.appendLine(`  ${f.status}: ${f.path}${f.oldPath ? ` (was ${f.oldPath})` : ''}`);
		}
	}
	if (status.unstaged.length > 0) {
		output.appendLine('');
		output.appendLine('## unstaged');
		for (const f of status.unstaged) {
			output.appendLine(`  ${f.status}: ${f.path}${f.oldPath ? ` (was ${f.oldPath})` : ''}`);
		}
	}
	if (status.untracked.length > 0) {
		output.appendLine('');
		output.appendLine('## untracked');
		for (const p of status.untracked) {
			output.appendLine(`  ${p}`);
		}
	}
	output.appendLine('');
}

/** Render a GitPullResult summary to the shared OutputChannel. */
function renderPull(
	output: vscode.OutputChannel,
	repoPath: string,
	result: GitPullResult,
): void {
	output.appendLine(`# git pull — ${repoPath}`);
	output.appendLine(
		`${result.updated.length} file(s) updated, +${result.insertions} / -${result.deletions}`,
	);
	for (const p of result.updated) {
		output.appendLine(`  ${p}`);
	}
	output.appendLine('');
}
