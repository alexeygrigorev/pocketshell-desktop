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
import { TmuxSessionPseudoterminal } from './tmux-session-terminal';

interface TmuxUiCommandTarget {
	hostId?: number;
	path?: string;
	sessionName?: string;
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
	_ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell tmux-ui');
	disposables.push(output);

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
		vscode.commands.registerCommand('pocketshell.tmux-ui.splitPane', async () => {
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

			const windowId = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Target window id (e.g. @1)'),
				validateInput: (v) =>
					v.startsWith('@') ? undefined : vscode.l10n.t('Window id must start with @'),
			});
			if (windowId === undefined) {
				return;
			}

			const pane = await withSessionManager(service, `split-pane ${windowId}`, async (manager) => {
				return manager.splitPane(windowId, direction.value);
			});
			if (pane === undefined) {
				return;
			}
			vscode.window.showInformationMessage(
				vscode.l10n.t('Split pane {0} ({1}x{2})', pane.id, pane.width, pane.height),
			);
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
			const hostId = await resolveHostId(service, target?.hostId ?? element, { connectedOnly: false });
			if (hostId === undefined) {
				return;
			}
			const host = await service.getHost(hostId);
			if (!host) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'));
				return;
			}
			const sessionName = target?.sessionName ?? await vscode.window.showInputBox({
				prompt: vscode.l10n.t('tmux session name to open or create'),
				value: target?.path ? sessionNameFromPath(target.path) : 'pocketshell',
			});
			if (!sessionName) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (!conn) {
				return;
			}

			const terminal = vscode.window.createTerminal({
				name: `tmux -CC: ${sessionName}`,
				pty: new TmuxSessionPseudoterminal(conn, sessionName, target?.path),
				iconPath: new vscode.ThemeIcon('terminal-tmux'),
			});
			terminal.show();
		}),
	);

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

function resolveTmuxUiTarget(element: unknown): TmuxUiCommandTarget | undefined {
	if (!element || typeof element !== 'object') {
		return undefined;
	}
	const value = element as Record<string, unknown>;
	return {
		hostId: typeof value.hostId === 'number' ? value.hostId : undefined,
		path: typeof value.path === 'string' ? value.path : undefined,
		sessionName: typeof value.sessionName === 'string' ? value.sessionName : undefined,
	};
}

function sessionNameFromPath(remotePath: string): string {
	const parts = remotePath.replace(/\/+$/, '').split('/').filter(Boolean);
	return sanitizeTmuxName(parts[parts.length - 1] || 'pocketshell');
}

function sanitizeTmuxName(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'pocketshell';
}
