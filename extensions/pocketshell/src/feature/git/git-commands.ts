/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect, resolveTargetPath } from '../../host-picking';
import { GitClient, PocketShellRepos, isGitNotRepositoryError } from '../../backend/git';
import type { SshConnection } from '../../backend/ssh/connection/ssh-client';
import type {
	GitStatus,
	GitPullResult,
	GitCommit,
	GitBranch,
	GitWorktree,
	PocketShellRepoBrowserEntry,
	PocketShellRepoEntry,
} from '../../backend/git';
import {
	buildGitHistoryPanelModel,
	renderGitHistoryPanelHtml,
	type GitHistoryPanelTab,
} from '../../backend/ui/git-history';
import type { FeatureDeps } from '../manifest';

type CloneRootPick = vscode.QuickPickItem & {
	manual: boolean;
	root: string;
};

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
	// pocketshell.git.history — read: open the Git History webview panel
	// -------------------------------------------------------------------------
	// One rich panel per host — reusing reveals it instead of recreating. The
	// panel renders the app-parity Overview (repo status / branches / worktrees)
	// + Commits timeline (app §6). The Issues tab is a deferred follow-up.
	const historyPanels = new Map<number, GitHistoryPanelEntry>();

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

			await openGitHistoryPanel(service, historyPanels, hostId, repoPath, conn);
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

	// Clean up all open git-history panels on extension dispose.
	disposables.push({
		dispose: () => {
			for (const entry of historyPanels.values()) {
				entry.panel.dispose();
			}
			historyPanels.clear();
		},
	});

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
	const manual: CloneRootPick = {
		label: vscode.l10n.t('Enter Manually'),
		description: vscode.l10n.t('Type a remote clone root'),
		root: '',
		manual: true,
	};
	const picked = await vscode.window.showQuickPick<CloneRootPick>([
		...roots.map((root) => ({
			label: root,
			description: root === '~/git' ? vscode.l10n.t('Default clone root') : vscode.l10n.t('Watched folder parent'),
			root,
			manual: false,
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

// ---------------------------------------------------------------------------
// Git History webview panel (app feature-parity §6: Overview + Commits)
// ---------------------------------------------------------------------------

interface GitHistoryPanelEntry {
	panel: vscode.WebviewPanel;
	nonce: string;
	hostId: number;
	repoPath: string;
	git: GitClient;
	tab: GitHistoryPanelTab;
}

interface GitHistoryPanelMessage {
	action?: 'refresh' | 'switchTab' | 'openGitHub';
	tab?: GitHistoryPanelTab;
	url?: string;
}

async function openGitHistoryPanel(
	service: ConnectionService,
	panels: Map<number, GitHistoryPanelEntry>,
	hostId: number,
	repoPath: string,
	conn: SshConnection,
): Promise<void> {
	let entry = panels.get(hostId);
	if (!entry) {
		const host = await service.getHost(hostId);
		const hostName = host?.name || host?.hostname || `Host ${hostId}`;
		const panel = vscode.window.createWebviewPanel(
			'pocketshell.git-history',
			vscode.l10n.t('Git History: {0}', hostName),
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
			repoPath,
			git: new GitClient(conn),
			tab: 'overview',
		};
		panels.set(hostId, entry);

		// Lesson #20: push webview subscriptions into a Disposable[] and
		// dispose them in onDidDispose. NEVER pass the panel as Event's 3rd arg.
		const webviewDisposables: vscode.Disposable[] = [];
		webviewDisposables.push(
			panel.webview.onDidReceiveMessage(async (message: GitHistoryPanelMessage) => {
				await handleGitHistoryPanelMessage(message, service, entry!);
			}),
		);
		panel.onDidDispose(() => {
			for (const d of webviewDisposables) {
				d.dispose();
			}
			panels.delete(hostId);
		});
	}
	// Re-target the panel if the host's selected repo changed.
	entry.repoPath = repoPath;
	await renderGitHistoryPanel(service, entry);
	entry.panel.reveal(vscode.ViewColumn.Active, true);
}

async function renderGitHistoryPanel(
	service: ConnectionService,
	entry: GitHistoryPanelEntry,
	status?: { tone: 'info' | 'success' | 'warning' | 'error'; message: string },
): Promise<void> {
	let statusData: GitStatus | undefined;
	let branches: GitBranch[] = [];
	let worktrees: GitWorktree[] = [];
	let commits: GitCommit[] = [];
	let originUrl: string | undefined;
	let missing = false;
	try {
		// `status` drives missing-repo detection: a GitNotRepositoryError from
		// it marks the repo missing rather than failing the whole panel. The
		// other sources are non-fatal and resolve to empty on error.
		statusData = await entry.git.status(entry.repoPath);
		[branches, worktrees, commits, originUrl] = await Promise.all([
			entry.git.branches(entry.repoPath).catch(() => [] as GitBranch[]),
			entry.git.worktree(entry.repoPath).catch(() => [] as GitWorktree[]),
			entry.git.log(entry.repoPath, { maxCount: 25 }).catch(() => [] as GitCommit[]),
			entry.git.remoteUrl(entry.repoPath).catch(() => undefined),
		]);
	} catch (err) {
		if (isGitNotRepositoryError(err)) {
			missing = true;
		} else {
			await setGitHistoryPanelError(entry, service, err);
			return;
		}
	}

	const host = await service.getHost(entry.hostId);
	const hostName = host?.name || host?.hostname || `Host ${entry.hostId}`;
	const model = buildGitHistoryPanelModel({
		repoPath: `${hostName}:${entry.repoPath}`,
		tab: entry.tab,
		status: statusData,
		branches,
		worktrees,
		commits,
		originUrl,
		statusBanner: status?.tone && status.message
			? { tone: status.tone, message: status.message }
			: undefined,
		missing,
	});

	entry.panel.title = vscode.l10n.t('Git History: {0}', hostName);
	entry.panel.webview.html = renderGitHistoryPanelHtml(model, {
		cspSource: entry.panel.webview.cspSource,
		nonce: entry.nonce,
	});
}

async function setGitHistoryPanelError(
	entry: GitHistoryPanelEntry,
	service: ConnectionService,
	err: unknown,
): Promise<void> {
	await renderGitHistoryPanel(service, entry, {
		tone: 'error',
		message: `Git history failed: ${err instanceof Error ? err.message : String(err)}`,
	});
}

async function handleGitHistoryPanelMessage(
	message: GitHistoryPanelMessage,
	service: ConnectionService,
	entry: GitHistoryPanelEntry,
): Promise<void> {
	const { action } = message;
	if (!action) {
		return;
	}
	try {
		if (action === 'refresh') {
			await renderGitHistoryPanel(service, entry);
			return;
		}
		if (action === 'switchTab') {
			if (message.tab) {
				entry.tab = message.tab;
			}
			await renderGitHistoryPanel(service, entry);
			return;
		}
		if (action === 'openGitHub') {
			if (message.url) {
				await vscode.env.openExternal(vscode.Uri.parse(message.url));
			}
			return;
		}
	} catch (err) {
		await renderGitHistoryPanel(service, entry, {
			tone: 'error',
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}
