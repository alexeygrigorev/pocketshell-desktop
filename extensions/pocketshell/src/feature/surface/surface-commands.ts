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
import { SessionConversationDefaultController } from './session-conversation-default-controller';
import { attributeSurfaceSession } from './surface-attribution';

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

	// -------------------------------------------------------------------------
	// pocketshell.session.openConversation (#106) — open THIS session's
	// Conversation editor tab. Resolves (hostId, sessionName) from a canonical
	// tree node (or args), focuses that session's terminal so the user is
	// oriented (never yanked away), attributes the active pane via the surface
	// registry's pty, and opens the per-session Conversation WebviewPanel as a
	// sibling editor tab. Switch terminal ↔ conversation via normal editor tabs.
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.session.openConversation', async (arg?: unknown, sessionName?: string) => {
			const target = resolveSessionTarget(arg, sessionName);
			if (!target) {
				return;
			}
			const entry = registry.get(target.hostId, target.sessionName);
			if (!entry) {
				return;
			}
			// Focus the session's terminal first so the user sees which session
			// the conversation belongs to (mirrors the app's terminal↔tab switch).
			entry.terminal.show(true);

			const pty = registry.getPty(target.hostId, entry.sessionName);
			const connection = pty?.getConnection();
			if (!pty || !connection) {
				void vscode.window.showWarningMessage(vscode.l10n.t('Connect to the host before opening the conversation.'));
				return;
			}
			const ref = await attributeSurfaceSession(pty, connection);
			if (!ref) {
				void vscode.window.showInformationMessage(vscode.l10n.t('No agent conversation was detected for this session. The terminal is shown.'));
				return;
			}
			// Open beside the terminal (not over it) so a right-click never yanks the
			// user off the terminal mid-session (#106: never yank a user).
			await vscode.commands.executeCommand('pocketshell.conversation.openForSession', {
				hostId: target.hostId,
				agentType: ref.agentType,
				sessionId: ref.id,
				viewColumn: vscode.ViewColumn.Beside,
			});
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.session.openPromptComposer (#106) — open the Prompt Composer
	// scoped to THIS session's agent. Mirrors the app: the composer sends text
	// to the session's pane via `tmux send-keys`. Resolves (hostId, sessionName)
	// from a canonical tree node (or args), focuses the terminal, then opens the
	// composer. When an agent is detected, the composer targets that agent
	// session; otherwise it falls back to the pane target (raw send-keys).
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.session.openPromptComposer', async (arg?: unknown, sessionName?: string) => {
			const target = resolveSessionTarget(arg, sessionName);
			if (!target) {
				return;
			}
			const entry = registry.get(target.hostId, target.sessionName);
			if (!entry) {
				return;
			}
			entry.terminal.show(true);
			const pty = registry.getPty(target.hostId, entry.sessionName);
			const connection = pty?.getConnection();
			if (!pty || !connection) {
				void vscode.window.showWarningMessage(vscode.l10n.t('Connect to the host before opening the prompt composer.'));
				return;
			}
			const metadata = pty.getActivePaneMetadata();
			const paneId = metadata?.id;
			const ref = await attributeSurfaceSession(pty, connection);
			if (ref) {
				// Agent session: open the composer scoped to the attributed agent.
				await vscode.commands.executeCommand('pocketshell.promptComposer.open', {
					target: {
						kind: 'agent',
						hostId: target.hostId,
						agentType: ref.agentType,
						sessionId: ref.id,
						label: `${ref.agentType}: ${ref.id}`,
						panelKey: `${target.hostId}:${ref.agentType}:${ref.id}`,
					},
				});
				return;
			}
			// No agent detected: open the composer targeting the raw pane so the
			// user can still send-keys into the session's tmux pane.
			await vscode.commands.executeCommand('pocketshell.promptComposer.open', {
				target: {
					kind: 'pane',
					hostId: target.hostId,
					paneId,
					label: `${entry.hostLabel}: ${entry.sessionName}${paneId ? ` ${paneId}` : ''}`,
				},
			});
		}),
	);

	// -------------------------------------------------------------------------
	// Conversation-default for agent sessions (#106, app §4 line 75): when a
	// session terminal connects, asynchronously probe for an agent; if one is
	// detected AND the user has not previously chosen Terminal for this session,
	// open the Conversation tab as a sibling. Per-session remembered choice wins;
	// never yanks a user mid-session off the terminal (the terminal stays
	// focused; the conversation opens beside it, not over it).
	// -------------------------------------------------------------------------
	const conversationDefaultController = new SessionConversationDefaultController(ctx, registry, service);
	disposables.push(conversationDefaultController);

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

