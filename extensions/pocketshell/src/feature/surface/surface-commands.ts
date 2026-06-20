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
import { CanonicalSessionTreeProvider } from './canonical-session-tree-provider';

/**
 * Terminal-surface commands.
 *
 * Parity connect flow (#103: 1 SSH connection + N tmux sessions per host):
 *   1. Resolve a host (from a tree item, or via the host quick-pick).
 *   2. getOrConnect() — reuse the live SSH connection (warm lease, keyed on
 *      hostId) or connect now. ONE connection per host, shared by all sessions.
 *   3. Dedup on (hostId, tmuxSessionName): if a terminal already exists for that
 *      exact (host, session) pair, just reveal it — never duplicate. A different
 *      sessionName on the same host opens an additional editor tab over the same
 *      connection.
 *   4. Otherwise create a {@link TmuxSessionPseudoterminal} (tmux -CC, backed
 *      by the existing src/tmux modules — create-or-attach via `new-session -A`)
 *      and open it as a vscode.Terminal in the EDITOR area (full-width tab),
 *      then register it on (hostId, sessionName).
 *
 * - `surface.connect` attaches to/creates the host's DEFAULT session
 *   (`pocketshell-<host>`). Calling it twice for the same host reuses the one
 *   default tab (idempotent — preserves the single-session UX).
 * - `surface.openSession` opens an ADDITIONAL named session on an
 *   already-connected host (the multi-session connect path).
 *
 * The left "Sessions" panel is driven by {@link CanonicalSessionTreeProvider},
 * which reads the same {@link SessionTerminalRegistry} and lists every open
 * (host, session) tab grouped by host.
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
	const treeProvider = new CanonicalSessionTreeProvider(registry);
	const treeView = vscode.window.createTreeView('pocketshell.sessions', {
		treeDataProvider: treeProvider,
		showCollapseAll: true,
	});
	disposables.push(treeView);

	// -------------------------------------------------------------------------
	// pocketshell.surface.connect — connect to a host and open its default
	// session's terminal tab (attach-or-create, one tab per (host, default session)).
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.surface.connect', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: false });
			if (hostId === undefined) {
				return;
			}

			const host = await service.getHost(hostId);
			if (!host) {
				vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'));
				return;
			}

			const hostLabel = host.name || host.hostname;
			// Default tmux session for this host: stable, host-derived (matches the
			// PocketShell Android app). Connecting twice reuses the same tab.
			const sessionName = tmuxSessionNameForHost(hostLabel);

			// One tab per (host, session): if this host's default session already has
			// a terminal, just focus it (never duplicate the default-session tab).
			const existing = registry.get(hostId, sessionName);
			if (existing) {
				existing.terminal.show(true);
				return;
			}

			const conn = await getOrConnect(service, hostId);
			if (!conn) {
				return;
			}

			// tmux -CC backing via TmuxSessionPseudoterminal, which uses TmuxClient
			// (src/tmux) with `new-session -A -s <name>` (create-or-attach — the same
			// behavior as the PocketShell Android app).
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
	// pocketshell.surface.openSession — open an ADDITIONAL tmux session on an
	// already-connected host (the multi-session connect path). Reuses the single
	// SSH connection; the new session gets its own editor tab keyed on
	// (hostId, sessionName). Mirrors the app's FolderList "+ new session" flow.
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.surface.openSession', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: false });
			if (hostId === undefined) {
				return;
			}

			const host = await service.getHost(hostId);
			if (!host) {
				vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'));
				return;
			}

			const hostLabel = host.name || host.hostname;

			// Ask for the session name. Default to a directory-style name so a
			// second session on the same host is distinct from the default.
			const sessionName = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('tmux session name to open or create on {0}', hostLabel),
				value: 'shell',
				validateInput: (value) =>
					value.trim().length === 0
						? vscode.l10n.t('Session name cannot be empty.')
						: value.includes(':')
							? vscode.l10n.t('tmux session names cannot contain ":".')
							: value.startsWith('.')
								? vscode.l10n.t('tmux session names cannot start with ".".')
								: undefined,
			});
			if (!sessionName) {
				return;
			}

			// Reuse the existing (host, session) tab if present; else create.
			const existing = registry.get(hostId, sessionName);
			if (existing) {
				existing.terminal.show(true);
				return;
			}

			const conn = await getOrConnect(service, hostId);
			if (!conn) {
				return;
			}

			const pty = new TmuxSessionPseudoterminal(conn, sessionName);
			const terminal = vscode.window.createTerminal({
				name: vscode.l10n.t('PocketShell: {0}: {1}', hostLabel, sessionName),
				pty,
				iconPath: new vscode.ThemeIcon('terminal-tmux'),
				location: vscode.TerminalLocation.Editor,
			});

			registry.register(hostId, hostLabel, sessionName, terminal, pty);
			terminal.show(true);
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.session.focusTerminal — reveal a session's editor tab.
	// Accepts: (hostId, sessionName?) | { hostId, sessionName? } | a tree node.
	// Without sessionName, focuses the host's first session tab.
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.session.focusTerminal', async (arg?: unknown, sessionName?: string) => {
			const target = resolveSessionTarget(arg, sessionName);
			if (!target) {
				return;
			}
			const entry = registry.get(target.hostId, target.sessionName);
			if (!entry) {
				return;
			}
			entry.terminal.show(true);
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.session.closeTerminal — close a session's terminal tab.
	// Accepts: (hostId, sessionName?) | { hostId, sessionName? } | a tree node.
	// Without sessionName, closes the host's first session tab.
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.session.closeTerminal', async (arg?: unknown, sessionName?: string) => {
			const target = resolveSessionTarget(arg, sessionName);
			if (!target) {
				return;
			}
			registry.remove(target.hostId, target.sessionName);
		}),
	);

	// When the extension deactivates, the registry disposal closes all tabs.
	ctx.subscriptions.push(registry);

	return disposables;
}

/**
 * Resolve a (hostId, sessionName) target from the variety of argument shapes
 * the focus/close commands receive: a bare hostId number, a `{hostId, sessionName?}`
 * object, or a canonical tree node `{kind:'session', entry:{hostId, sessionName}}`.
 * `sessionName` is optional throughout — when absent the host's first session is
 * addressed (single-session back-compat).
 */
function resolveSessionTarget(arg: unknown, sessionName?: string): { hostId: number; sessionName?: string } | undefined {
	if (typeof arg === 'number') {
		return { hostId: arg, sessionName };
	}
	if (arg && typeof arg === 'object') {
		// Canonical tree session node: { kind: 'session', entry: { hostId, sessionName } }.
		const maybeEntry = (arg as { entry?: { hostId?: unknown; sessionName?: unknown } }).entry;
		if (maybeEntry && typeof maybeEntry.hostId === 'number') {
			return { hostId: maybeEntry.hostId, sessionName: maybeEntry.sessionName as string | undefined };
		}
		// Plain object: { hostId, sessionName? }.
		const maybeHostId = (arg as { hostId?: unknown }).hostId;
		if (typeof maybeHostId === 'number') {
			return { hostId: maybeHostId, sessionName: (arg as { sessionName?: string }).sessionName };
		}
	}
	return undefined;
}

