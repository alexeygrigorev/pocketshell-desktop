/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import type { SshConnection } from '../../backend/ssh/connection/ssh-client';
import { resolveHostId, getOrConnect, resolveTargetPath } from '../../host-picking';
import { SftpClient } from '../../backend/files/sftp-client';
import { FileBrowser, remoteFileUriParts, resolveFileBrowserStartDirectory } from '../../backend/files/file-browser';
import { RemoteFileWatcher } from '../../backend/files/file-watcher';
import type { RemoteFileEntry } from '../../backend/files/types';
import {
	buildRemoteFileReviewPrompt,
	classifyRemoteFileEntryPreview,
	classifyRemoteFileStatPreview,
	formatBytes,
	looksLikeBinarySample,
	type RemoteFilePreviewPlan,
} from '../../backend/files/remote-file-preview';
import type { FeatureDeps } from '../manifest';

/**
 * Files feature: registers commands that drive the remote {@link FileBrowser}
 * (QuickPick directory navigation) and {@link RemoteFileWatcher} (polling
 * change detection piped to an OutputChannel) over an SSH connection.
 *
 * A single `PocketShell Files` OutputChannel is reused across commands. One
 * SftpClient is cached per host and reused while connected; watchers are
 * tracked so "Files: Stop Watching" and extension deactivation can dispose
 * them cleanly. All created disposables are returned to the caller.
 */
export function registerFiles(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Files');
	disposables.push(output);

	const state = new FilesState(output);
	disposables.push(state);

	// -------------------------------------------------------------------------
	// pocketshell.files.browse — QuickPick directory navigation
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.files.browse', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const targetPath = resolveTargetPath(element);
			const activePaneCwd = targetPath ? undefined : await resolveActivePaneCwd(element);
			const startPath = resolveFileBrowserStartDirectory({ path: targetPath, cwd: activePaneCwd });

			try {
				await browseLoop(state, conn, hostId, startPath);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Files browse failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.files.watch — poll a directory, log changes to OutputChannel
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.files.watch', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const targetPath = resolveTargetPath(element);
			const watchPath = targetPath ?? await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Directory to watch'),
				value: '~',
			});
			if (watchPath === undefined) {
				return;
			}

			try {
				await state.watch(conn, hostId, watchPath);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Files watch failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.files.openPreview — classify and preview a remote file
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.files.openPreview', async (element?: unknown) => {
			try {
				const target = await resolveRemoteFileTarget(service, state, element);
				if (!target) {
					return;
				}
				await openRemoteFilePreview(state, target.conn, target.hostId, target.path, target.entry);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to preview remote file: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.files.review — insert a remote-file review prompt in composer
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.files.review', async (element?: unknown) => {
			try {
				const target = await resolveRemoteFileTarget(service, state, element);
				if (!target) {
					return;
				}
				await attachRemoteFileReviewPrompt(state, target.conn, target.hostId, target.path, target.entry);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to create file review prompt: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.files.stopWatch — stop all watchers + drop cached clients
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.files.stopWatch', () => {
			const count = state.stopAll();
			output.appendLine(
				count > 0
					? vscode.l10n.t('Stopped watching {0} director{1}.', count, count === 1 ? 'y' : 'ies')
					: 'No active watches.',
			);
			output.show(true);
		}),
	);

	return disposables;
}

// -----------------------------------------------------------------------------
// Per-registration state
// -----------------------------------------------------------------------------

interface ActiveWatch {
	watcher: RemoteFileWatcher;
	path: string;
}

/**
 * Tracks one cached {@link SftpClient} per host plus all active watchers, so
 * commands can reuse a live client and "Stop Watching" / deactivation can
 * dispose everything cleanly. Change events are routed to the shared
 * `output` channel.
 */
class FilesState implements vscode.Disposable {
	private readonly clients = new Map<number, SftpClient>();
	private readonly watches = new Map<string, ActiveWatch>();

	constructor(private readonly output: vscode.OutputChannel) {}

	/**
	 * Get or open the cached SftpClient for `hostId`, reusing it while it stays
	 * connected and rebuilding a dropped client.
	 */
	async client(hostId: number, conn: SshConnection): Promise<SftpClient> {
		const existing = this.clients.get(hostId);
		if (existing && existing.connected) {
			return existing;
		}
		if (existing) {
			existing.disconnect();
			this.clients.delete(hostId);
		}
		const client = new SftpClient(conn);
		await client.connect();
		this.clients.set(hostId, client);
		return client;
	}

	/**
	 * Get or create a watcher for `hostId` + `path`, wiring its change event to
	 * the shared OutputChannel. Watchers are keyed by `hostId:path` so
	 * re-watching the same directory is a no-op.
	 */
	async watch(conn: SshConnection, hostId: number, path: string): Promise<void> {
		const key = watchKey(hostId, path);
		if (this.watches.has(key)) {
			this.output.appendLine(
				vscode.l10n.t('Already watching {0} on {1}', path, hostLabel(hostId)),
			);
			return;
		}

		const client = await this.client(hostId, conn);
		const watcher = new RemoteFileWatcher(client);
		watcher.onChange((changedPath) => {
			this.output.appendLine(`[change] ${hostLabel(hostId)} ${changedPath}`);
		});
		await watcher.watch(path);
		this.watches.set(key, { watcher, path });

		this.output.appendLine(
			vscode.l10n.t('Watching {0} on {1}', path, hostLabel(hostId)),
		);
	}

	/** Stop and forget every active watcher. Returns how many were stopped. */
	stopAll(): number {
		const count = this.watches.size;
		for (const { watcher } of this.watches.values()) {
			watcher.unwatchAll();
		}
		this.watches.clear();
		return count;
	}

	dispose(): void {
		this.stopAll();
		for (const client of this.clients.values()) {
			client.disconnect();
		}
		this.clients.clear();
	}
}

function watchKey(hostId: number, path: string): string {
	return `${hostId}:${path}`;
}

function hostLabel(hostId: number): string {
	return `host${hostId}`;
}

// -----------------------------------------------------------------------------
// Browse interaction
// -----------------------------------------------------------------------------

/** QuickPick item carrying a directory entry or a navigation action. */
type BrowseItem =
	| (vscode.QuickPickItem & { action: 'entry'; entry: RemoteFileEntry })
	| (vscode.QuickPickItem & { action: 'up' | 'refresh' | 'open' });

/**
 * Drive a {@link FileBrowser} from `startPath` with a QuickPick UI. The user
 * descends into directories, navigates up, refreshes, or opens a file. The
 * browser owns navigation state; selecting a file delegates to the existing
 * `pocketshell.openRemoteFile` command.
 */
async function browseLoop(
	state: FilesState,
	conn: SshConnection,
	hostId: number,
	startPath: string,
): Promise<void> {
	const client = await state.client(hostId, conn);
	const browser = new FileBrowser(client, { rootPath: startPath });

	// Initial navigation may fail (bad path, permission denied) — surface it.
	await browser.navigate(startPath);

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const items: BrowseItem[] = [];

		if (browser.currentPath !== '/') {
			items.push({
				action: 'up',
				label: '$(arrow-up) Up to parent',
				description: vscode.l10n.t('Go up one level'),
			});
		}
		items.push({
			action: 'refresh',
			label: '$(refresh) Refresh',
			description: vscode.l10n.t('Reload this directory'),
		});
		items.push({
			action: 'open',
			label: '$(folder-opened) Open by path…',
			description: vscode.l10n.t('Enter an absolute path'),
		});

		for (const e of browser.currentEntries) {
			items.push({
				action: 'entry',
				label: e.isDirectory ? `$(folder) ${e.name}` : `$(file) ${e.name}`,
				description: e.isDirectory ? 'directory' : formatSize(e.size),
				entry: e,
			});
		}

		const picked = (await vscode.window.showQuickPick(items, {
			placeHolder: vscode.l10n.t('{0} — select an entry', browser.currentPath),
			matchOnDescription: true,
		})) as BrowseItem | undefined;

		if (picked === undefined) {
			return; // cancelled
		}

		switch (picked.action) {
			case 'up':
				await browser.goUp();
				continue;
			case 'refresh':
				await browser.refresh();
				continue;
			case 'open': {
				const entered = await vscode.window.showInputBox({
					prompt: vscode.l10n.t('Absolute path to open'),
					value: browser.currentPath,
				});
				if (entered === undefined) {
					continue;
				}
				await browser.navigate(entered);
				continue;
			}
			case 'entry':
				if (picked.entry.isDirectory) {
					await browser.navigate(picked.entry.path);
					continue;
				}
				{
					const action = await vscode.window.showQuickPick([
						{
							label: '$(preview) Preview',
							description: vscode.l10n.t('Open a text, markdown, image, or unsupported preview'),
							action: 'preview' as const,
						},
						{
							label: '$(comment-add) Review with Agent',
							description: vscode.l10n.t('Add a review prompt to the current prompt composer'),
							action: 'review' as const,
						},
					], {
						placeHolder: vscode.l10n.t('{0} — choose an action', picked.entry.path),
					});
					if (!action) {
						continue;
					}
					if (action.action === 'review') {
						await attachRemoteFileReviewPrompt(state, conn, hostId, picked.entry.path, picked.entry);
					} else {
						await openRemoteFilePreview(state, conn, hostId, picked.entry.path, picked.entry);
					}
				}
				return;
		}
	}
}

/** Format a byte count as a compact human-readable string. */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function resolveActivePaneCwd(element: unknown): Promise<string | undefined> {
	if (!hasEntryId(element)) {
		return undefined;
	}
	try {
		const metadata = await vscode.commands.executeCommand<{ cwd?: unknown }>(
			'pocketshell.tmux-ui.getActivePaneMetadata',
			element,
		);
		return typeof metadata?.cwd === 'string' && metadata.cwd.trim() ? metadata.cwd : undefined;
	} catch {
		return undefined;
	}
}

function hasEntryId(element: unknown): boolean {
	return !!element
		&& typeof element === 'object'
		&& typeof (element as { entryId?: unknown }).entryId === 'string';
}

interface RemoteFileCommandTarget {
	hostId: number;
	conn: SshConnection;
	path: string;
	entry?: RemoteFileEntry;
}

interface RemoteFileCommandArgs {
	hostId?: number;
	path?: string;
	entry?: RemoteFileEntry;
}

async function resolveRemoteFileTarget(
	service: ConnectionService,
	state: FilesState,
	element: unknown,
): Promise<RemoteFileCommandTarget | undefined> {
	const args = normalizeRemoteFileCommandArgs(element);
	const hostId = args.hostId ?? await resolveHostId(service, element, { connectedOnly: true });
	if (hostId === undefined) {
		return undefined;
	}
	const conn = await getOrConnect(service, hostId);
	if (conn === null) {
		return undefined;
	}
	const path = args.path ?? resolveTargetPath(element) ?? await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Remote file path'),
		value: '~',
	});
	if (path === undefined || !path.trim()) {
		return undefined;
	}
	const client = await state.client(hostId, conn);
	const remotePath = path.trim().startsWith('/')
		? path.trim()
		: await client.realpath(path.trim());
	return {
		hostId,
		conn,
		path: remotePath,
		entry: args.entry,
	};
}

function normalizeRemoteFileCommandArgs(element: unknown): RemoteFileCommandArgs {
	if (!element || typeof element !== 'object') {
		return {};
	}
	const value = element as {
		hostId?: unknown;
		path?: unknown;
		remotePath?: unknown;
		entry?: unknown;
	};
	const entry = normalizeRemoteFileEntry(value.entry);
	return {
		hostId: typeof value.hostId === 'number' ? value.hostId : undefined,
		path: typeof value.path === 'string'
			? value.path
			: typeof value.remotePath === 'string'
				? value.remotePath
				: entry?.path,
		entry,
	};
}

function normalizeRemoteFileEntry(input: unknown): RemoteFileEntry | undefined {
	if (!input || typeof input !== 'object') {
		return undefined;
	}
	const value = input as Partial<RemoteFileEntry>;
	if (typeof value.path !== 'string' || typeof value.name !== 'string') {
		return undefined;
	}
	return {
		name: value.name,
		path: value.path,
		isDirectory: value.isDirectory === true,
		isFile: value.isFile !== false,
		isSymbolicLink: value.isSymbolicLink === true,
		size: typeof value.size === 'number' ? value.size : 0,
		modifiedAt: typeof value.modifiedAt === 'number' ? value.modifiedAt : 0,
		permissions: value.permissions,
	};
}

async function resolvePreviewPlan(
	state: FilesState,
	conn: SshConnection,
	hostId: number,
	path: string,
	entry?: RemoteFileEntry,
): Promise<{ client: SftpClient; plan: RemoteFilePreviewPlan }> {
	const client = await state.client(hostId, conn);
	if (entry) {
		return { client, plan: classifyRemoteFileEntryPreview(entry) };
	}
	const stat = await client.stat(path);
	return { client, plan: classifyRemoteFileStatPreview(path, stat) };
}

async function openRemoteFilePreview(
	state: FilesState,
	conn: SshConnection,
	hostId: number,
	path: string,
	entry?: RemoteFileEntry,
): Promise<void> {
	const { client, plan } = await resolvePreviewPlan(state, conn, hostId, path, entry);
	if (plan.kind === 'text' || plan.kind === 'markdown') {
		if (await textPlanLooksBinary(client, plan)) {
			await showRemoteFileStatusPanel(hostId, {
				...plan,
				kind: 'unsupported',
				reason: 'File contents appear to be binary.',
			});
			return;
		}
		const uri = vscode.Uri.from(remoteFileUriParts(hostId, path));
		const doc = await vscode.workspace.openTextDocument(uri);
		if (plan.kind === 'markdown') {
			await vscode.commands.executeCommand('markdown.showPreview', uri);
		} else {
			await vscode.window.showTextDocument(doc);
		}
		return;
	}
	if (plan.kind === 'image') {
		const data = await client.readFile(path);
		await showRemoteImagePanel(hostId, plan, data);
		return;
	}
	await showRemoteFileStatusPanel(hostId, plan);
}

async function textPlanLooksBinary(client: SftpClient, plan: RemoteFilePreviewPlan): Promise<boolean> {
	if (plan.size === 0) {
		return false;
	}
	const data = await client.readFile(plan.path);
	return looksLikeBinarySample(data.subarray(0, Math.min(data.length, 4096)));
}

async function attachRemoteFileReviewPrompt(
	state: FilesState,
	conn: SshConnection,
	hostId: number,
	path: string,
	entry?: RemoteFileEntry,
): Promise<void> {
	const { plan } = await resolvePreviewPlan(state, conn, hostId, path, entry);
	const prompt = buildRemoteFileReviewPrompt({
		hostLabel: hostLabel(hostId),
		path,
		size: plan.size,
		previewKind: plan.kind,
		reason: plan.reason,
	});
	await vscode.commands.executeCommand('pocketshell.promptComposer.open', {
		prefillText: prompt,
	});
}

async function showRemoteImagePanel(hostId: number, plan: RemoteFilePreviewPlan, data: Buffer): Promise<void> {
	const panel = vscode.window.createWebviewPanel(
		'pocketshell.remoteFilePreview',
		vscode.l10n.t('Remote Preview: {0}', plan.displayName),
		vscode.ViewColumn.Active,
		{ enableScripts: true },
	);
	wirePreviewPanelMessages(panel, hostId, plan);
	const src = `data:${plan.mediaType ?? 'application/octet-stream'};base64,${data.toString('base64')}`;
	panel.webview.html = renderRemoteFilePreviewHtml(plan, {
		body: `<img class="preview-image" src="${src}" alt="${escapeHtml(plan.displayName)}">`,
	});
}

async function showRemoteFileStatusPanel(hostId: number, plan: RemoteFilePreviewPlan): Promise<void> {
	const panel = vscode.window.createWebviewPanel(
		'pocketshell.remoteFilePreview',
		vscode.l10n.t('Remote Preview: {0}', plan.displayName),
		vscode.ViewColumn.Active,
		{ enableScripts: true },
	);
	wirePreviewPanelMessages(panel, hostId, plan);
	panel.webview.html = renderRemoteFilePreviewHtml(plan, {
		body: `<div class="state ${plan.kind}">
			<h2>${escapeHtml(plan.kind === 'large' ? 'Preview skipped' : 'Preview unavailable')}</h2>
			<p>${escapeHtml(plan.reason ?? 'This file type is not supported for preview.')}</p>
			<p class="muted">Size: ${escapeHtml(formatBytes(plan.size))}. Preview limit: ${escapeHtml(formatBytes(plan.previewLimit))}.</p>
		</div>`,
	});
}

function wirePreviewPanelMessages(
	panel: vscode.WebviewPanel,
	hostId: number,
	plan: RemoteFilePreviewPlan,
): void {
	panel.webview.onDidReceiveMessage(async (message: { action?: string }) => {
		if (message.action !== 'review') {
			return;
		}
		const prompt = buildRemoteFileReviewPrompt({
			hostLabel: hostLabel(hostId),
			path: plan.path,
			size: plan.size,
			previewKind: plan.kind,
			reason: plan.reason,
		});
		await vscode.commands.executeCommand('pocketshell.promptComposer.open', {
			prefillText: prompt,
		});
	});
}

function renderRemoteFilePreviewHtml(plan: RemoteFilePreviewPlan, options: { body: string }): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(plan.displayName)}</title>
<style>
body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
.toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
button { margin-left: auto; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 2px; padding: 5px 10px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
main { padding: 16px; }
.preview-image { display: block; max-width: 100%; max-height: calc(100vh - 86px); object-fit: contain; margin: 0 auto; }
.state { max-width: 680px; border: 1px solid var(--vscode-panel-border); padding: 16px; }
.state h2 { margin: 0 0 8px; font-size: 18px; }
.state p { margin: 0 0 8px; }
.muted { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header class="toolbar">
<div class="title">${escapeHtml(plan.displayName)}</div>
<div class="meta">${escapeHtml(plan.path)} · ${escapeHtml(formatBytes(plan.size))}</div>
<button type="button" id="review">Review with Agent</button>
</header>
<main>${options.body}</main>
<script>
const vscode = acquireVsCodeApi();
document.getElementById('review').addEventListener('click', () => vscode.postMessage({ action: 'review' }));
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
