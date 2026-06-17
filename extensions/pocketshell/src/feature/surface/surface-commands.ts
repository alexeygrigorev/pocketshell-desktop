/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import type { FeatureDeps } from '../manifest';
import { TmuxSessionPseudoterminal } from '../tmux-ui/tmux-session-terminal';
import { tmuxSessionNameForHost } from '../../backend/terminal/session-terminal-map';
import { SessionTerminalRegistry } from './session-terminal-registry';
import { SessionTreeProvider } from './session-tree-provider';

/**
 * Terminal-surface commands.
 *
 * The connect flow:
 *   1. Resolve a host (from a tree item, or via the host quick-pick).
 *   2. getOrConnect() — reuse the live SSH connection or connect now.
 *   3. If a session terminal already exists for this host, just reveal it
 *      (one tab per session — never duplicate).
 *   4. Otherwise create a {@link TmuxSessionPseudoterminal} (tmux -CC, backed
 *      by the existing src/tmux modules — create-or-attach via `new-session -A`)
 *      and open it as a vscode.Terminal in the EDITOR area (full-width tab),
 *      then register it.
 *
 * The left "Sessions" panel is driven by {@link SessionTreeProvider}, which
 * reads the same {@link SessionTerminalRegistry}.
 */
export function registerSurface(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const registry = new SessionTerminalRegistry();
	disposables.push(registry);

	// -- Sessions tree view (left panel) -------------------------------------
	const treeProvider = new SessionTreeProvider(registry);
	const treeView = vscode.window.createTreeView('pocketshell.sessions', {
		treeDataProvider: treeProvider,
		showCollapseAll: false,
	});
	disposables.push(treeView);

	// -------------------------------------------------------------------------
	// pocketshell.surface.connect — connect to a host and open its terminal tab
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.surface.connect', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: false });
			if (hostId === undefined) {
				return;
			}

			// One tab per session: if this host already has a terminal, just focus it.
			const existing = registry.get(hostId);
			if (existing) {
				existing.terminal.show(true);
				return;
			}

			const host = await service.getHost(hostId);
			if (!host) {
				vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'));
				return;
			}

			const conn = await getOrConnect(service, hostId);
			if (!conn) {
				return;
			}

			const hostLabel = host.name || host.hostname;
			// tmux session name per PocketShell session: stable, host-derived.
			const sessionName = tmuxSessionNameForHost(hostLabel);

			// tmux -CC backing via the existing TmuxSessionPseudoterminal, which
			// uses TmuxClient (src/tmux) with `new-session -A -s <name>`
			// (create-or-attach — the same behavior as the PocketShell Android app).
			const pty = new TmuxSessionPseudoterminal(conn, sessionName);

			// Open the terminal as a FULL-WIDTH EDITOR TAB (not the bottom panel).
			const terminal = vscode.window.createTerminal({
				name: vscode.l10n.t('PocketShell: {0}', hostLabel),
				pty,
				iconPath: new vscode.ThemeIcon('terminal-tmux'),
				location: vscode.TerminalLocation.Editor,
			});

			registry.register(hostId, hostLabel, sessionName, terminal, pty);
			terminal.show(true);
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.session.focusTerminal — reveal a session's editor tab
	// (used as the click handler for rows in the Sessions panel)
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.session.focusTerminal', async (hostId?: number) => {
			if (typeof hostId !== 'number') {
				return;
			}
			const entry = registry.get(hostId);
			if (!entry) {
				return;
			}
			entry.terminal.show(true);
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.session.closeTerminal — close a session's terminal tab
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.session.closeTerminal', async (hostId?: number) => {
			if (typeof hostId !== 'number') {
				return;
			}
			registry.remove(hostId);
		}),
	);

	// When the extension deactivates, the registry disposal closes all tabs.
	ctx.subscriptions.push(registry);

	return disposables;
}
