/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { TmuxClient } from '../../backend/tmux/client';
import { SshShellBridge } from '../../backend/tmux/ssh-shell-bridge';
import { TmuxSessionManager } from '../../backend/tmux-ui/tmux-session-manager';
import { buildSnapshot } from '../../backend/tmux-ui/snapshot-builder';
import { getTerminalManager } from '../terminal';
import type { FeatureDeps } from '../manifest';
import type { SplitDirection } from '../../backend/tmux-ui/types';
import type { SshConnection } from '../../backend/ssh/connection/ssh-client';
import { quoteShellArg } from '../../backend/sessions/create-session';
import {
	decideTmuxStartupRestore,
	parseTmuxRestoreTarget,
	readTmuxRestoreSettings,
	serializeTmuxRestoreTarget,
	targetFromSnapshot,
	type TmuxRestoreTarget,
} from '../../backend/tmux-ui/restore-state';
import { TmuxSessionPseudoterminal } from './tmux-session-terminal';
import { TmuxSessionRegistry, type RegisteredTmuxSession } from './tmux-session-registry';
import { TmuxTreeProvider } from './tmux-tree-provider';
import { getKillTargetFromTmuxTreeNode, type TmuxTreeNode, type TmuxTreePaneNode, type TmuxTreeSessionNode, type TmuxTreeWindowNode } from '../../backend/tmux-ui/tree-model';
import type { TmuxPaneInfo, TmuxSessionInfo, TmuxWindowInfo } from '../../backend/tmux-ui/types';

const RESTORE_STATE_KEY = 'pocketshell.tmuxUi.lastTarget';

interface TmuxUiCommandTarget {
	hostId?: number;
	path?: string;
	cwd?: string;
	sessionName?: string;
	sessionId?: string;
	windowId?: string;
	paneId?: string;
	restore?: boolean;
	requireExisting?: boolean;
}

/**
 * tmux-ui feature: a higher-level management layer over {@link TmuxSessionManager}
 * that mirrors the read/mutate pattern of the base tmux feature but operates on
 * the session manager (which keeps {@link TerminalManager} pane<->terminal
 * mappings in sync) instead of a raw {@link TmuxClient}.
 *
 * Each command resolves a connected host, opens an interactive shell, wraps it
 * in an {@link SshShellBridge}, constructs + starts a fresh {@link TmuxSessionManager},
 * drives its API, and stops the manager (detaching the underlying shell) in a
 * `finally`. A single `PocketShell tmux-ui` OutputChannel is reused across
 * commands.
 *
 * The {@link TerminalManager} is obtained defensively via {@link getTerminalManager};
 * if the terminal feature has not been registered yet, the command warns and bails.
 */
export function registerTmuxUi(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell tmux-ui');
	disposables.push(output);
	const registry = new TmuxSessionRegistry();
	const treeProvider = new TmuxTreeProvider(registry);
	const treeView = vscode.window.createTreeView('pocketshell.tmuxSessions', {
		treeDataProvider: treeProvider,
		showCollapseAll: true,
	});
	disposables.push(registry, treeView);
	const restoreStore = new TmuxRestoreStore(ctx);

	// -------------------------------------------------------------------------
	// pocketshell.tmux-ui.showTree — read: render a hierarchical snapshot
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.tmux-ui.showTree', async () => {
			const snapshot = await withSessionManager(service, 'show-tree', async (manager, _hostId) => {
				return buildSnapshot(manager.getState(), manager.getPaneTerminalMap());
			});
			if (snapshot === undefined) {
				return;
			}

			output.appendLine('# tmux session tree');
			if (snapshot.sessions.length === 0) {
				output.appendLine('(no tmux sessions)');
			}
			for (const session of snapshot.sessions) {
				const marker = session.isActive ? '*' : ' ';
				output.appendLine(`${marker} session ${session.name} (${session.id})`);
				for (const window of session.windows) {
					const wMarker = window.isActive ? '*' : ' ';
					output.appendLine(`  ${wMarker} window ${window.name} (${window.id}) [${window.panes.length} pane(s)]`);
					for (const pane of window.panes) {
						const pMarker = pane.isActive ? '*' : ' ';
						const term = pane.hasTerminal ? ` -> terminal ${pane.terminalId}` : '';
						output.appendLine(`    ${pMarker} pane ${pane.id} ${pane.width}x${pane.height}${term}`);
					}
				}
			}
			output.appendLine('');
			output.show(true);
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.tmux-ui.newSession — mutate: create a session via the manager
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.tmux-ui.newSession', async () => {
			const name = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('New tmux session name'),
				value: 'pocketshell',
			});
			if (name === undefined) {
				return;
			}

			const created = await withSessionManager(service, `new-session ${name}`, async (manager) => {
				return manager.createSession(name);
			});
			if (created === undefined) {
				return;
			}
			vscode.window.showInformationMessage(
				vscode.l10n.t('Created tmux session {0} ({1})', created.name, created.id),
			);
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.tmux-ui.splitPane — mutate: split the active window's pane
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.tmux-ui.splitPane', async (element?: unknown) => {
			const direction = await vscode.window.showQuickPick(
				[
					{ label: 'Vertical', value: 'vertical' as SplitDirection },
					{ label: 'Horizontal', value: 'horizontal' as SplitDirection },
				],
				{ placeHolder: vscode.l10n.t('Split direction') },
			);
			if (direction === undefined) {
				return;
			}

			const target = findPaneTarget(registry, element);
			try {
				if (target) {
					await target.entry.pty.splitPane(target.pane.id, direction.value);
					return;
				}
				const entry = await resolveEntry(registry, element);
				if (!entry) {
					return;
				}
				await entry.pty.splitActivePane(direction.value);
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to split pane: {0}', String(err)));
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.tmux-ui.capturePane — read: capture visible content of a pane
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.tmux-ui.capturePane', async () => {
			const paneId = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Target pane id (e.g. %0)'),
				validateInput: (v) =>
					v.startsWith('%') ? undefined : vscode.l10n.t('Pane id must start with %'),
			});
			if (paneId === undefined) {
				return;
			}

			const captured = await withSessionManager(service, `capture-pane ${paneId}`, async (manager) => {
				return manager.capturePane(paneId);
			});
			if (captured === undefined) {
				return;
			}

			output.appendLine(`# tmux capture-pane ${paneId}`);
			output.appendLine(captured);
			output.appendLine('');
			output.show(true);
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.tmux-ui.openSession', async (element?: unknown) => {
			const target = resolveTmuxUiTarget(element);
			await openTmuxUiSession(service, registry, restoreStore, target, element);
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.tmux-ui.forgetRestoreState', async () => {
			await restoreStore.clear();
			void vscode.window.showInformationMessage(vscode.l10n.t('Forgot the last tmux UI session restore state.'));
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.tmux-ui.refreshTree', async () => {
			await Promise.all(registry.entries().map((entry) => entry.pty.refreshState()));
			treeProvider.refresh();
		}),
		vscode.commands.registerCommand('pocketshell.tmux-ui.selectPane', async (element?: unknown) => {
			const target = await resolvePaneTarget(registry, element);
			if (!target) {
				return;
			}
			try {
				await target.entry.pty.selectPane(target.pane.id, target.session.id, target.window.id);
				target.entry.terminal.show();
				await persistRestoreTarget(restoreStore, target.entry);
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to select pane: {0}', String(err)));
			}
		}),
		vscode.commands.registerCommand('pocketshell.tmux-ui.newWindow', async (element?: unknown) => {
			const target = await resolveSessionTarget(registry, element);
			if (!target) {
				return;
			}
			const name = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('New tmux window name'),
			});
			if (name === undefined) {
				return;
			}
			try {
				await target.entry.pty.newWindow(target.session.id, name || undefined, target.cwd);
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to create window: {0}', String(err)));
			}
		}),
		vscode.commands.registerCommand('pocketshell.tmux-ui.splitTreePane', async (element?: unknown) => {
			const target = await resolvePaneTarget(registry, element);
			if (!target) {
				return;
			}
			const direction = await vscode.window.showQuickPick(
				[
					{ label: 'Vertical', value: 'vertical' as SplitDirection },
					{ label: 'Horizontal', value: 'horizontal' as SplitDirection },
				],
				{ placeHolder: vscode.l10n.t('Split direction') },
			);
			if (!direction) {
				return;
			}
			try {
				await target.entry.pty.splitPane(target.pane.id, direction.value);
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to split pane: {0}', String(err)));
			}
		}),
		vscode.commands.registerCommand('pocketshell.tmux-ui.captureTreePane', async (element?: unknown) => {
			const target = await resolvePaneTarget(registry, element);
			if (!target) {
				return;
			}
			try {
				const captured = await target.entry.pty.capturePane(target.pane.id);
				output.appendLine(`# tmux capture-pane ${target.pane.id}`);
				output.appendLine(captured);
				output.appendLine('');
				output.show(true);
				return captured;
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to capture pane: {0}', String(err)));
				return undefined;
			}
		}),
		vscode.commands.registerCommand('pocketshell.tmux-ui.captureActivePane', async (element?: unknown) => {
			const entry = await resolveEntry(registry, element);
			if (!entry) {
				return undefined;
			}
			try {
				const metadata = entry.pty.getActivePaneMetadata();
				const captured = await entry.pty.captureActivePane();
				output.appendLine(`# tmux capture-pane ${metadata?.id ?? 'active'}`);
				output.appendLine(captured);
				output.appendLine('');
				output.show(true);
				return captured;
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to capture active pane: {0}', String(err)));
				return undefined;
			}
		}),
		vscode.commands.registerCommand('pocketshell.tmux-ui.sendTextToPane', async (element?: unknown) => {
			const target = await resolvePaneTarget(registry, element);
			if (!target) {
				return;
			}
			const text = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Text to send to pane {0}', target.pane.id),
				ignoreFocusOut: true,
			});
			if (text === undefined) {
				return;
			}
			const submit = await vscode.window.showQuickPick(
				[
					{ label: 'Send text only', value: false },
					{ label: 'Send text and Enter', value: true },
				],
				{ placeHolder: vscode.l10n.t('Send mode') },
			);
			if (submit === undefined) {
				return;
			}
			try {
				await target.entry.pty.sendTextToPane(target.pane.id, text, submit.value);
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to send text: {0}', String(err)));
			}
		}),
		vscode.commands.registerCommand('pocketshell.tmux-ui.sendKeysToPane', async (element?: unknown) => {
			const target = await resolvePaneTarget(registry, element);
			if (!target) {
				return;
			}
			const value = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('tmux key names for pane {0} (space separated)', target.pane.id),
				value: 'Enter',
				validateInput: validateTmuxKeyInput,
				ignoreFocusOut: true,
			});
			if (value === undefined) {
				return;
			}
			try {
				await target.entry.pty.sendKeysToPane(target.pane.id, parseTmuxKeyInput(value));
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to send keys: {0}', String(err)));
			}
		}),
		vscode.commands.registerCommand('pocketshell.tmux-ui.resizeTreePane', async (element?: unknown) => {
			const target = await resolvePaneTarget(registry, element);
			if (!target) {
				return;
			}
			const value = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Pane size as columns x rows'),
				value: `${target.pane.width}x${target.pane.height}`,
				validateInput: validatePaneSizeInput,
			});
			if (value === undefined) {
				return;
			}
			const size = parsePaneSizeInput(value);
			if (!size) {
				return;
			}
			try {
				await target.entry.pty.resizePane(target.pane.id, size.width, size.height);
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to resize pane: {0}', String(err)));
			}
		}),
		vscode.commands.registerCommand('pocketshell.tmux-ui.getActivePaneMetadata', async (element?: unknown) => {
			const entry = await resolveEntry(registry, element);
			return entry?.pty.getActivePaneMetadata();
		}),
		vscode.commands.registerCommand('pocketshell.tmux-ui.renameTreeItem', async (element?: unknown) => {
			const target = await resolveRenameTarget(registry, element);
			if (!target) {
				return;
			}
			const name = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('New name'),
				value: target.currentName,
			});
			if (!name) {
				return;
			}
			try {
				if (target.kind === 'session') {
					await target.entry.pty.renameSession(target.id, name);
				} else {
					await target.entry.pty.renameWindow(target.id, name);
				}
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to rename tmux item: {0}', String(err)));
			}
		}),
		vscode.commands.registerCommand('pocketshell.tmux-ui.killTreeItem', async (element?: unknown) => {
			const target = await resolveKillTarget(registry, element);
			if (!target) {
				return;
			}
			const killLabel = vscode.l10n.t('Kill');
			const confirmed = await vscode.window.showWarningMessage(
				vscode.l10n.t('Kill tmux {0} "{1}"?', target.kind, target.label),
				{ modal: true },
				killLabel,
			);
			if (confirmed !== killLabel) {
				return;
			}
			try {
				if (target.kind === 'session') {
					await target.entry.pty.killSession(target.id);
				} else if (target.kind === 'window') {
					await target.entry.pty.killWindow(target.id);
				} else {
					await target.entry.pty.killPane(target.id);
				}
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to kill tmux item: {0}', String(err)));
			}
		}),
		vscode.commands.registerCommand('pocketshell.tmux-ui.detachTreeSession', async (element?: unknown) => {
			const entry = await resolveEntry(registry, element);
			if (!entry) {
				return;
			}
			try {
				await entry.pty.detach();
				entry.terminal.dispose();
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to detach tmux session: {0}', String(err)));
			}
		}),
	);

	void restoreTmuxUiSessionOnStartup(service, registry, restoreStore, deps);

	return disposables;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Resolve a connected host, open a shell, wrap it, construct + start a
 * {@link TmuxSessionManager} (backed by the {@link TerminalManager} singleton),
 * and run `fn` against it. The manager is always stopped after `fn` resolves or
 * throws.
 *
 * @returns the value returned by `fn`, or `undefined` if the user cancelled,
 *          the terminal feature is inactive, the connection failed, or tmux
 *          failed to start.
 */
async function withSessionManager<T>(
	service: ConnectionService,
	label: string,
	fn: (manager: TmuxSessionManager, hostId: number) => Promise<T>,
): Promise<T | undefined> {
	const terminalManager = getTerminalManager();
	if (terminalManager === undefined) {
		void vscode.window.showWarningMessage(
			vscode.l10n.t('Terminal feature not active; start a terminal first'),
		);
		return undefined;
	}

	const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
	if (hostId === undefined) {
		return undefined;
	}

	const conn = await getOrConnect(service, hostId);
	if (conn === null) {
		return undefined;
	}

	const shell = await conn.shell();
	const channel = new SshShellBridge(shell);
	const tmuxClient = new TmuxClient({ sessionName: 'pocketshell' });
	const manager = new TmuxSessionManager(tmuxClient, terminalManager);

	try {
		await manager.start(channel, hostId);
		return await fn(manager, hostId);
	} catch (err) {
		void vscode.window.showErrorMessage(
			vscode.l10n.t('tmux-ui {0} failed: {1}', label, String(err)),
		);
		return undefined;
	} finally {
		try {
			await manager.stop();
		} catch {
			// Best effort — the shell/channel are closed by manager.stop()/client.detach().
			try {
				await tmuxClient.close();
			} catch {
				// ignore
			}
		}
	}
}

class TmuxRestoreStore {
	constructor(private readonly ctx: vscode.ExtensionContext) {}

	load(): TmuxRestoreTarget | null {
		return parseTmuxRestoreTarget(this.ctx.globalState.get(RESTORE_STATE_KEY));
	}

	async save(target: TmuxRestoreTarget): Promise<void> {
		await this.ctx.globalState.update(RESTORE_STATE_KEY, serializeTmuxRestoreTarget(target));
	}

	async clear(): Promise<void> {
		await this.ctx.globalState.update(RESTORE_STATE_KEY, undefined);
	}
}

async function openTmuxUiSession(
	service: ConnectionService,
	registry: TmuxSessionRegistry,
	restoreStore: TmuxRestoreStore,
	target: TmuxUiCommandTarget | undefined,
	element: unknown,
): Promise<RegisteredTmuxSession | undefined> {
	const hostId = await resolveHostId(service, target?.hostId ?? element, { connectedOnly: false });
	if (hostId === undefined) {
		return undefined;
	}
	const host = await service.getHost(hostId);
	if (!host) {
		await restoreStore.clear();
		void vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'), vscode.l10n.t('Forget Restore State'))
			.then((choice) => choice && restoreStore.clear());
		return undefined;
	}
	const sessionName = target?.sessionName ?? await vscode.window.showInputBox({
		prompt: vscode.l10n.t('tmux session name to open or create'),
		value: target?.path ? sessionNameFromPath(target.path) : 'pocketshell',
	});
	if (!sessionName) {
		return undefined;
	}
	const conn = await getOrConnect(service, hostId);
	if (!conn) {
		await showReconnectMessage(hostId, host.name || host.hostname, restoreStore);
		return undefined;
	}
	if (target?.requireExisting && !(await hasTmuxSession(conn, sessionName))) {
		await restoreStore.clear();
		void vscode.window.showWarningMessage(
			vscode.l10n.t('The restored tmux session "{0}" no longer exists on {1}.', sessionName, host.name || host.hostname),
			vscode.l10n.t('Open Host Detail'),
		).then((choice) => {
			if (choice) {
				void vscode.commands.executeCommand('pocketshell.hostDetail.open', hostId);
			}
		});
		await vscode.commands.executeCommand('pocketshell.hostDetail.open', hostId);
		return undefined;
	}

	const hostLabel = host.name || host.hostname;
	const pty = new TmuxSessionPseudoterminal(conn, sessionName, target?.path ?? target?.cwd);
	const terminal = vscode.window.createTerminal({
		name: `tmux -CC: ${sessionName}`,
		pty,
		iconPath: new vscode.ThemeIcon('terminal-tmux'),
	});
	const entry = {
		hostId,
		hostLabel,
		sessionName,
		terminal,
		pty,
		path: target?.path,
	};
	registry.register(entry);
	const registered = registry.entries().find((candidate) => candidate.terminal === terminal && candidate.pty === pty);
	const liveEntry = registered ? registry.get(registered.id) : undefined;
	if (liveEntry) {
		registry.addEntryDisposable(liveEntry.id, attachRestorePersistence(restoreStore, liveEntry));
		if (target?.restore || target?.requireExisting) {
			registry.addEntryDisposable(liveEntry.id, attachRestoreOpenFailureActions(restoreStore, liveEntry));
		}
	}
	terminal.show();

	await restoreStore.save({
		hostId,
		hostLabel,
		sessionName,
		sessionId: target?.sessionId,
		windowId: target?.windowId,
		paneId: target?.paneId,
		cwd: target?.cwd,
		path: target?.path,
		updatedAt: Date.now(),
	});

	if (liveEntry && target?.paneId) {
		void selectRestoredPaneWhenReady(liveEntry, target);
	}

	return liveEntry;
}

function attachRestorePersistence(
	restoreStore: TmuxRestoreStore,
	entry: RegisteredTmuxSession,
): vscode.Disposable {
	const update = () => {
		void persistRestoreTarget(restoreStore, entry);
	};
	const stateSub = entry.pty.onDidChangeState(update);
	const closeSub = entry.pty.onDidClose(() => {
		stateSub.dispose();
		closeSub.dispose();
	});
	return new vscode.Disposable(() => {
		stateSub.dispose();
		closeSub.dispose();
	});
}

function attachRestoreOpenFailureActions(
	restoreStore: TmuxRestoreStore,
	entry: RegisteredTmuxSession,
): vscode.Disposable {
	const closeSub = entry.pty.onDidClose((exitCode) => {
		closeSub.dispose();
		if (exitCode === 0) {
			return;
		}
		const hostDetailLabel = vscode.l10n.t('Open Host Detail');
		const forgetLabel = vscode.l10n.t('Forget Restore State');
		void vscode.window.showErrorMessage(
			vscode.l10n.t('Could not restore tmux session "{0}" on {1}.', entry.sessionName, entry.hostLabel),
			hostDetailLabel,
			forgetLabel,
		).then(async (choice) => {
			if (choice === hostDetailLabel) {
				await vscode.commands.executeCommand('pocketshell.hostDetail.open', entry.hostId);
			} else if (choice === forgetLabel) {
				await restoreStore.clear();
			}
		});
	});
	return closeSub;
}

async function persistRestoreTarget(
	restoreStore: TmuxRestoreStore,
	entry: RegisteredTmuxSession,
): Promise<void> {
	const state = entry.pty.getState();
	if (!state) {
		return;
	}
	const snapshot = buildSnapshot(state, new Map());
	await restoreStore.save(targetFromSnapshot({
		hostId: entry.hostId,
		hostLabel: entry.hostLabel,
		sessionName: entry.sessionName,
		path: entry.path,
	}, snapshot, Date.now()));
}

async function selectRestoredPaneWhenReady(
	entry: RegisteredTmuxSession,
	target: TmuxUiCommandTarget,
): Promise<void> {
	const paneId = target.paneId;
	if (!paneId) {
		return;
	}
	const started = Date.now();
	while (Date.now() - started < 5_000) {
		const state = entry.pty.getState();
		const snapshot = state ? buildSnapshot(state, new Map()) : undefined;
		const pane = snapshot?.sessions
			.flatMap((session) => session.windows.flatMap((window) => window.panes.map((candidate) => ({ session, window, pane: candidate }))))
			.find((candidate) => candidate.pane.id === paneId);
		if (pane) {
			await entry.pty.selectPane(pane.pane.id, pane.session.id, pane.window.id);
			return;
		}
		await delay(100);
	}
}

async function restoreTmuxUiSessionOnStartup(
	service: ConnectionService,
	registry: TmuxSessionRegistry,
	restoreStore: TmuxRestoreStore,
	deps: FeatureDeps,
): Promise<void> {
	const target = restoreStore.load();
	const settings = readTmuxRestoreSettings(deps.getSettings?.());
	const hostReady = target ? service.getConnection(target.hostId) !== null : false;
	const decision = decideTmuxStartupRestore({
		enabled: settings.restoreSessionOnStartup,
		behavior: settings.sessionRestoreBehavior,
		target,
		hostReady,
	});
	if (decision.action === 'skip') {
		return;
	}

	const restore = async () => openTmuxUiSession(service, registry, restoreStore, {
		...decision.target,
		restore: true,
		requireExisting: true,
	}, decision.target);

	if (decision.action === 'restore') {
		await restore();
		return;
	}

	const label = decision.target.hostLabel ?? String(decision.target.hostId);
	const restoreLabel = vscode.l10n.t('Restore');
	const hostDetailLabel = vscode.l10n.t('Open Host Detail');
	const forgetLabel = vscode.l10n.t('Forget Restore State');
	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t('Restore tmux session "{0}" on {1}?', decision.target.sessionName, label),
		restoreLabel,
		hostDetailLabel,
		forgetLabel,
	);
	if (choice === restoreLabel) {
		await restore();
	} else if (choice === hostDetailLabel) {
		await vscode.commands.executeCommand('pocketshell.hostDetail.open', decision.target.hostId);
	} else if (choice === forgetLabel) {
		await restoreStore.clear();
	}
}

async function hasTmuxSession(conn: SshConnection, sessionName: string): Promise<boolean> {
	try {
		const result = await conn.exec(`tmux has-session -t ${quoteShellArg(sessionName)}`, 3_000);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

async function showReconnectMessage(
	hostId: number,
	hostLabel: string,
	restoreStore: TmuxRestoreStore,
): Promise<void> {
	const connectLabel = vscode.l10n.t('Connect');
	const hostDetailLabel = vscode.l10n.t('Open Host Detail');
	const forgetLabel = vscode.l10n.t('Forget Restore State');
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t('Could not connect to {0} for tmux restore.', hostLabel),
		connectLabel,
		hostDetailLabel,
		forgetLabel,
	);
	if (choice === connectLabel) {
		await vscode.commands.executeCommand('pocketshell.connect', hostId);
	} else if (choice === hostDetailLabel) {
		await vscode.commands.executeCommand('pocketshell.hostDetail.open', hostId);
	} else if (choice === forgetLabel) {
		await restoreStore.clear();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveTmuxUiTarget(element: unknown): TmuxUiCommandTarget | undefined {
	if (!element || typeof element !== 'object') {
		return undefined;
	}
	const value = element as Record<string, unknown>;
	return {
		hostId: typeof value.hostId === 'number' ? value.hostId : undefined,
		path: typeof value.path === 'string' ? value.path : undefined,
		cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
		sessionName: typeof value.sessionName === 'string' ? value.sessionName : undefined,
		sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
		windowId: typeof value.windowId === 'string' ? value.windowId : undefined,
		paneId: typeof value.paneId === 'string' ? value.paneId : undefined,
		restore: value.restore === true,
		requireExisting: value.requireExisting === true,
	};
}

function sessionNameFromPath(remotePath: string): string {
	const parts = remotePath.replace(/\/+$/, '').split('/').filter(Boolean);
	return sanitizeTmuxName(parts[parts.length - 1] || 'pocketshell');
}

function sanitizeTmuxName(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'pocketshell';
}

interface PaneTarget {
	entry: RegisteredTmuxSession;
	session: TmuxSessionInfo;
	window: TmuxWindowInfo;
	pane: TmuxPaneInfo;
}

interface SessionTarget {
	entry: RegisteredTmuxSession;
	session: TmuxSessionInfo;
	cwd: string | undefined;
}

async function resolveEntry(
	registry: TmuxSessionRegistry,
	element: unknown,
): Promise<RegisteredTmuxSession | undefined> {
	const entryId = getEntryId(element);
	if (entryId) {
		return registry.get(entryId);
	}
	const picked = await vscode.window.showQuickPick(
		registry.entries().map((entry) => ({
			label: entry.label,
			description: entry.snapshot?.activePaneId ?? entry.sessionName,
			entry,
		})),
		{ placeHolder: vscode.l10n.t('Select tmux session terminal') },
	);
	return picked?.entry;
}

async function resolvePaneTarget(
	registry: TmuxSessionRegistry,
	element: unknown,
): Promise<PaneTarget | undefined> {
	const direct = findPaneTarget(registry, element);
	if (direct) {
		return direct;
	}
	const picks = collectPaneTargets(registry);
	const picked = await vscode.window.showQuickPick(
		picks.map((target) => ({
			label: `${target.pane.id} ${target.pane.cwd ?? ''}`.trim(),
			description: `${target.session.name} / ${target.window.name}`,
			target,
		})),
		{ placeHolder: vscode.l10n.t('Select tmux pane') },
	);
	return picked?.target;
}

async function resolveSessionTarget(
	registry: TmuxSessionRegistry,
	element: unknown,
): Promise<SessionTarget | undefined> {
	const paneTarget = findPaneTarget(registry, element);
	if (paneTarget) {
		return { entry: paneTarget.entry, session: paneTarget.session, cwd: paneTarget.pane.cwd };
	}
	const node = element as Partial<TmuxTreeNode> | undefined;
	const entry = await resolveEntry(registry, element);
	if (!entry) {
		return undefined;
	}
	const snapshot = registry.entries().find((candidate) => candidate.id === entry.id)?.snapshot;
	const sessions = snapshot?.sessions ?? [];
	if (node?.kind === 'session') {
		const session = sessions.find((candidate) => candidate.id === (node as TmuxTreeSessionNode).session?.id);
		if (session) {
			return { entry, session, cwd: undefined };
		}
	}
	if (node?.kind === 'window') {
		const windowNode = node as TmuxTreeWindowNode;
		const session = sessions.find((candidate) => candidate.id === windowNode.session?.id);
		if (session) {
			return { entry, session, cwd: undefined };
		}
	}
	const activeSession = sessions.find((session) => session.isActive) ?? sessions[0];
	if (activeSession) {
		return { entry, session: activeSession, cwd: undefined };
	}
	return undefined;
}

async function resolveRenameTarget(
	registry: TmuxSessionRegistry,
	element: unknown,
): Promise<{ kind: 'session' | 'window'; entry: RegisteredTmuxSession; id: string; currentName: string } | undefined> {
	const entry = await resolveEntry(registry, element);
	const node = element as Partial<TmuxTreeNode> | undefined;
	if (entry && node?.kind === 'session' && (node as TmuxTreeSessionNode).session) {
		const session = (node as TmuxTreeSessionNode).session;
		return { kind: 'session', entry, id: session.id, currentName: session.name };
	}
	if (entry && node?.kind === 'window' && (node as TmuxTreeWindowNode).window) {
		const window = (node as TmuxTreeWindowNode).window;
		return { kind: 'window', entry, id: window.id, currentName: window.name };
	}
	const picks = registry.entries().flatMap((treeEntry) => {
		const live = registry.get(treeEntry.id);
		if (!live || !treeEntry.snapshot) {
			return [];
		}
		return treeEntry.snapshot.sessions.flatMap((session) => [
			{ label: session.name, description: `session ${session.id}`, target: { kind: 'session' as const, entry: live, id: session.id, currentName: session.name } },
			...session.windows.map((window) => ({
				label: window.name,
				description: `window ${window.id} in ${session.name}`,
				target: { kind: 'window' as const, entry: live, id: window.id, currentName: window.name },
			})),
		]);
	});
	const picked = await vscode.window.showQuickPick(picks, { placeHolder: vscode.l10n.t('Select tmux item to rename') });
	return picked?.target;
}

async function resolveKillTarget(
	registry: TmuxSessionRegistry,
	element: unknown,
): Promise<{ kind: 'session' | 'window' | 'pane'; entry: RegisteredTmuxSession; id: string; label: string } | undefined> {
	const node = element as Partial<TmuxTreeNode> | undefined;
	const entryId = getEntryId(element);
	const entry = entryId ? registry.get(entryId) : undefined;
	if (entry && isTmuxTreeNode(node)) {
		const target = getKillTargetFromTmuxTreeNode(node);
		if (target) {
			return { ...target, entry };
		}
	}
	const pane = findPaneTarget(registry, element);
	if (pane) {
		return { kind: 'pane', entry: pane.entry, id: pane.pane.id, label: pane.pane.id };
	}
	const picks = registry.entries().flatMap((treeEntry) => {
		const live = registry.get(treeEntry.id);
		if (!live || !treeEntry.snapshot) {
			return [];
		}
		return treeEntry.snapshot.sessions.flatMap((session) => [
			{ label: session.name, description: `session ${session.id}`, target: { kind: 'session' as const, entry: live, id: session.id, label: session.name } },
			...session.windows.flatMap((window) => [
				{ label: window.name, description: `window ${window.id}`, target: { kind: 'window' as const, entry: live, id: window.id, label: window.name } },
				...window.panes.map((paneInfo) => ({
					label: paneInfo.id,
					description: paneInfo.cwd,
					target: { kind: 'pane' as const, entry: live, id: paneInfo.id, label: paneInfo.id },
				})),
			]),
		]);
	});
	const picked = await vscode.window.showQuickPick(picks, { placeHolder: vscode.l10n.t('Select tmux item to kill') });
	return picked?.target;
}

function findPaneTarget(registry: TmuxSessionRegistry, element: unknown): PaneTarget | undefined {
	const node = element as Partial<TmuxTreePaneNode | TmuxTreeWindowNode> | undefined;
	const entryId = getEntryId(element);
	if (!entryId) {
		return undefined;
	}
	const entry = registry.get(entryId);
	const treeEntry = registry.entries().find((candidate) => candidate.id === entryId);
	if (!entry || !treeEntry?.snapshot) {
		return undefined;
	}
	if (node?.kind === 'pane' && (node as Partial<TmuxTreePaneNode>).pane) {
		const pane = (node as Partial<TmuxTreePaneNode>).pane!;
		return findPaneTargetById(entry, treeEntry.snapshot.sessions, pane.id);
	}
	if (node?.kind === 'window' && (node as Partial<TmuxTreeWindowNode>).window) {
		const window = (node as Partial<TmuxTreeWindowNode>).window!;
		const pane = window.panes.find((candidate) => candidate.isActive) ?? window.panes[0];
		return pane ? findPaneTargetById(entry, treeEntry.snapshot.sessions, pane.id) : undefined;
	}
	return undefined;
}

function findPaneTargetById(
	entry: RegisteredTmuxSession,
	sessions: TmuxSessionInfo[],
	paneId: string,
): PaneTarget | undefined {
	for (const session of sessions) {
		for (const window of session.windows) {
			const pane = window.panes.find((candidate) => candidate.id === paneId);
			if (pane) {
				return { entry, session, window, pane };
			}
		}
	}
	return undefined;
}

function collectPaneTargets(registry: TmuxSessionRegistry): PaneTarget[] {
	return registry.entries().flatMap((treeEntry) => {
		const entry = registry.get(treeEntry.id);
		if (!entry || !treeEntry.snapshot) {
			return [];
		}
		return treeEntry.snapshot.sessions.flatMap((session) =>
			session.windows.flatMap((window) =>
				window.panes.map((pane) => ({ entry, session, window, pane })),
			),
		);
	});
}

function getEntryId(element: unknown): string | undefined {
	if (!element || typeof element !== 'object') {
		return undefined;
	}
	const value = element as Record<string, unknown>;
	return typeof value.entryId === 'string' ? value.entryId : undefined;
}

function isTmuxTreeNode(node: Partial<TmuxTreeNode> | undefined): node is TmuxTreeNode {
	if (node?.kind === 'root') {
		return typeof (node as { entryId?: unknown }).entryId === 'string';
	}
	if (node?.kind === 'session') {
		return (node as Partial<TmuxTreeSessionNode>).session !== undefined;
	}
	if (node?.kind === 'window') {
		return (node as Partial<TmuxTreeWindowNode>).window !== undefined;
	}
	if (node?.kind === 'pane') {
		return (node as Partial<TmuxTreePaneNode>).pane !== undefined;
	}
	return false;
}

function parseTmuxKeyInput(value: string): string[] {
	return value.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

function validateTmuxKeyInput(value: string): string | undefined {
	const keys = parseTmuxKeyInput(value);
	if (keys.length === 0) {
		return vscode.l10n.t('Enter at least one tmux key name.');
	}
	const unsafe = keys.find((key) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key));
	return unsafe ? vscode.l10n.t('Unsupported tmux key name: {0}', unsafe) : undefined;
}

function parsePaneSizeInput(value: string): { width: number; height: number } | undefined {
	const match = value.trim().match(/^(\d+)\s*x\s*(\d+)$/i);
	if (!match) {
		return undefined;
	}
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 20 || height < 5) {
		return undefined;
	}
	return { width, height };
}

function validatePaneSizeInput(value: string): string | undefined {
	return parsePaneSizeInput(value)
		? undefined
		: vscode.l10n.t('Use columns x rows, for example 120x40.');
}
