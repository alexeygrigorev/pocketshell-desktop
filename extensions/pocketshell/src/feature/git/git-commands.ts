/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect, resolveTargetPath } from '../../host-picking';
import { GitClient, PocketShellRepos, isGitNotRepositoryError } from '../../backend/git';
import type {
	GitStatus,
	GitPullResult,
	GitCommit,
	PocketShellRepoBrowserEntry,
	PocketShellRepoEntry,
} from '../../backend/git';
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
	// pocketshell.git.browse — read+pick+mutate: list, clone, open session
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.git.browse', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: false });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const repos = new PocketShellRepos(conn);
			let rows: PocketShellRepoBrowserEntry[];
			try {
				rows = await loadRepoBrowserRows(repos);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Git repositories failed: {0}', String(err)),
				);
				return;
			}

			if (rows.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No GitHub or local repositories found.'));
				return;
			}

			const picked = await vscode.window.showQuickPick(
				rows.map((row) => toRepoPick(row)),
				{ placeHolder: vscode.l10n.t('Choose a repository to open') },
			);
			if (!picked) {
				return;
			}

			let repoPath = picked.row.path;
			if (!repoPath) {
				const cloneRoot = await pickCloneRoot(service, hostId);
				if (cloneRoot === undefined) {
					return;
				}
				try {
					repoPath = await repos.clone(picked.row.fullName, cloneRoot);
					deps.refreshTrees();
					vscode.window.showInformationMessage(
						vscode.l10n.t('Cloned {0}', picked.row.fullName),
					);
				} catch (err) {
					vscode.window.showErrorMessage(
						vscode.l10n.t('Git clone failed: {0}', String(err)),
					);
					return;
				}
			}

			const action = await pickRepoAction(repoPath);
			if (action === 'history') {
				await vscode.commands.executeCommand('pocketshell.git.history', {
					hostId,
					path: repoPath,
				});
				return;
			}
			if (action === 'session') {
				await vscode.commands.executeCommand('pocketshell.sessions.create', {
					hostId,
					path: repoPath,
				});
			}
		}),
	);

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

			const repoPath = resolveTargetPath(element) ?? await vscode.window.showInputBox({
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

			const repoPath = resolveTargetPath(element) ?? await vscode.window.showInputBox({
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
	// pocketshell.git.history — read: render recent commit history
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.git.history', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const repoPath = resolveTargetPath(element) ?? await vscode.window.showInputBox({
				prompt: 'Repository path',
				value: '/home/',
			});
			if (repoPath === undefined) {
				return;
			}

			output.clear();
			try {
				const commits = await new GitClient(conn).log(repoPath, { maxCount: 25 });
				renderHistory(output, repoPath, commits);
				output.show(true);
			} catch (err) {
				if (isGitNotRepositoryError(err)) {
					vscode.window.showInformationMessage(
						vscode.l10n.t('No Git history: {0} is not a Git repository.', repoPath),
					);
					return;
				}
				vscode.window.showErrorMessage(
					vscode.l10n.t('Git history failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.git.pull — mutate: pull upstream, then refresh trees
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.git.pull', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const repoPath = resolveTargetPath(element) ?? await vscode.window.showInputBox({
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

async function pickRepoAction(repoPath: string): Promise<'session' | 'history' | undefined> {
	const picked = await vscode.window.showQuickPick([
		{
			label: vscode.l10n.t('Open Session'),
			description: repoPath,
			action: 'session' as const,
		},
		{
			label: vscode.l10n.t('Show History'),
			description: repoPath,
			action: 'history' as const,
		},
	], {
		placeHolder: vscode.l10n.t('Choose repository action'),
	});
	return picked?.action;
}

async function loadRepoBrowserRows(repos: PocketShellRepos): Promise<PocketShellRepoBrowserEntry[]> {
	let remote: PocketShellRepoEntry[] = [];
	try {
		remote = await repos.listRemote();
	} catch (err) {
		vscode.window.showWarningMessage(
			vscode.l10n.t('GitHub repositories unavailable: {0}', String(err)),
		);
	}
	const local = await repos.listLocal();
	return mergeRepoEntries(remote, local);
}

function toRepoPick(row: PocketShellRepoBrowserEntry): vscode.QuickPickItem & { row: PocketShellRepoBrowserEntry } {
	return {
		label: row.fullName,
		description: row.cloned ? vscode.l10n.t('Open') : vscode.l10n.t('Clone'),
		detail: row.path ?? row.defaultBranch ?? row.remote?.htmlUrl,
		row,
	};
}

async function pickCloneRoot(
	service: ConnectionService,
	hostId: number,
): Promise<string | undefined> {
	const watchedFolders = await service.getWatchedFolders(hostId);
	const roots = uniqueStrings([
		'~/git',
		...watchedFolders
			.filter((folder) => folder.enabled)
			.map((folder) => parentPath(folder.path)),
	]);
	const manual: vscode.QuickPickItem & { manual?: boolean; root?: string } = {
		label: vscode.l10n.t('Enter Manually'),
		description: vscode.l10n.t('Type a remote clone root'),
		manual: true,
	};
	const picked = await vscode.window.showQuickPick([
		...roots.map((root) => ({
			label: root,
			description: root === '~/git' ? vscode.l10n.t('Default clone root') : vscode.l10n.t('Watched folder parent'),
			root,
		})),
		manual,
	], {
		placeHolder: vscode.l10n.t('Choose a clone root'),
	});
	if (!picked) {
		return undefined;
	}
	return vscode.window.showInputBox({
		prompt: vscode.l10n.t('Clone root'),
		value: picked.manual ? '' : picked.root,
		placeHolder: '~/git',
		validateInput: (value: string) => value.trim() ? undefined : vscode.l10n.t('Clone root is required'),
	});
}

function parentPath(path: string): string {
	const trimmed = path.replace(/\/+$/, '');
	const index = trimmed.lastIndexOf('/');
	if (index <= 0) {
		return trimmed || '/';
	}
	return trimmed.slice(0, index);
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) {
			continue;
		}
		seen.add(value);
		result.push(value);
	}
	return result;
}

function mergeRepoEntries(
	remote: PocketShellRepoEntry[],
	local: PocketShellRepoEntry[],
): PocketShellRepoBrowserEntry[] {
	const localByKey = new Map(local.map((entry) => [joinKey(entry), entry]));
	const seen = new Set<string>();
	const rows: PocketShellRepoBrowserEntry[] = [];

	for (const entry of remote) {
		const key = joinKey(entry);
		seen.add(key);
		const localMatch = localByKey.get(key);
		rows.push({
			fullName: key,
			name: entry.name,
			owner: entry.owner,
			cloned: localMatch?.local !== undefined,
			path: localMatch?.local?.path,
			defaultBranch: entry.remote?.defaultBranch,
			updatedAt: entry.remote?.updatedAt,
			remote: entry.remote,
		});
	}

	for (const entry of local) {
		const key = joinKey(entry);
		if (seen.has(key) || !entry.local) {
			continue;
		}
		seen.add(key);
		rows.push({
			fullName: key,
			name: entry.name,
			owner: entry.owner,
			cloned: true,
			path: entry.local.path,
			defaultBranch: entry.remote?.defaultBranch,
			updatedAt: entry.remote?.updatedAt,
			remote: entry.remote,
		});
	}

	return rows.sort((a, b) => {
		if (a.cloned !== b.cloned) {
			return a.cloned ? -1 : 1;
		}
		const updated = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
		return updated !== 0 ? updated : a.name.localeCompare(b.name);
	});
}

function joinKey(entry: PocketShellRepoEntry): string {
	if (entry.fullName) {
		return entry.fullName;
	}
	return entry.owner ? `${entry.owner}/${entry.name}` : entry.name;
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

/** Render recent commit history to the shared OutputChannel. */
function renderHistory(
	output: vscode.OutputChannel,
	repoPath: string,
	commits: GitCommit[],
): void {
	output.appendLine(`# git history — ${repoPath}`);
	if (commits.length === 0) {
		output.appendLine('(no commits)');
		output.appendLine('');
		return;
	}
	for (const commit of commits) {
		const date = commit.date ? commit.date.slice(0, 10) : 'unknown-date';
		output.appendLine(`${commit.shortHash}  ${date}  ${commit.author}  ${commit.subject}`);
		if (commit.files.length === 0) {
			output.appendLine('  (no file summary)');
			continue;
		}
		for (const file of commit.files) {
			const path = file.oldPath ? `${file.oldPath} => ${file.path}` : file.path;
			const summary = file.binary
				? 'binary'
				: `+${file.insertions ?? 0} -${file.deletions ?? 0}`;
			output.appendLine(`  ${summary}  ${path}`);
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
