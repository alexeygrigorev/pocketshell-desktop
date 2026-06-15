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
				// File: open via the pocketshell:// FileSystemProvider, mirroring the
				// core `pocketshell.openRemoteFile` command but with the host + path
				// already known (the core command re-prompts for both).
				try {
					const uri = vscode.Uri.from(remoteFileUriParts(hostId, picked.entry.path));
					const doc = await vscode.workspace.openTextDocument(uri);
					await vscode.window.showTextDocument(doc);
				} catch (err) {
					vscode.window.showErrorMessage(
						vscode.l10n.t('Failed to open remote file: {0}', String(err)),
					);
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
