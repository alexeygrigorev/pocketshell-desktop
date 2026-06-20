/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { getOrConnect } from '../../host-picking';
import type { SessionTerminalRegistry } from './session-terminal-registry';
import { attributeSurfaceSession } from './surface-attribution';

/**
 * Per-session Conversations-tab default controller (#106, app parity §4 line 75).
 *
 * Mirrors the PocketShell Android app: for a session with a **detected agent**,
 * the Conversation tab opens **by default** (as a sibling editor tab beside the
 * terminal) the first time the session connects — UNLESS the user has already
 * chosen Terminal for that session. Per-session remembered choice always wins,
 * and the terminal is never yanked away mid-session: the terminal stays focused,
 * and the conversation opens in `ViewColumn.Beside` (revealed without stealing
 * focus), so a user actively typing in the terminal is never interrupted.
 *
 * The agent probe is best-effort and asynchronous: it waits for the pty's tmux
 * state to be ready, then attributes the active pane. Detection can legitimately
 * fail (no agent running, still warming up); in that case nothing opens and the
 * terminal remains the default — matching the app's "Conversation tab appears
 * only when an agent is detected" behavior.
 *
 * Transient probe failures (pty not yet ready within the wait window, SSH not
 * yet connected) do NOT permanently suppress the session: the session is only
 * marked probed once an agent is detected OR the probe completes with the pty
 * ready (no-match is a stable result once the tmux state exists). A session that
 * fails to probe is retried on the next registry change, so closing and
 * reconnecting a session re-probes it.
 *
 * The per-session remembered choice is stored in workspaceState under
 * `pocketshell.conversationDefault.<hostId>:<sessionName>` with values:
 *   - undefined (never set): default applies (open conversation for agent sessions)
 *   - 'terminal': user chose terminal for this session — never auto-open conversation
 *   - 'conversation': user chose conversation — open it (handled by explicit action)
 */
export class SessionConversationDefaultController implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	/** Sessions currently being probed (dedup so a reconnect doesn't double-fire). */
	private readonly probing = new Set<string>();
	/** Sessions that have reached a STABLE probe result (agent detected, or pty-ready
	 *  with no match). Transient failures are NOT recorded here, so they retry. */
	private readonly probed = new Set<string>();
	private readonly connectionService: ConnectionService | undefined;

	constructor(
		private readonly ctx: vscode.ExtensionContext,
		private readonly registry: SessionTerminalRegistry,
		connectionService?: ConnectionService,
	) {
		this.connectionService = connectionService;
		this.disposables.push(this.registry.onDidChange(() => this.onRegistryChanged()));
	}

	/** Mark a session's remembered default view ('terminal' suppresses auto-open). */
	async rememberChoice(hostId: number, sessionName: string, choice: 'terminal' | 'conversation'): Promise<void> {
		await this.ctx.workspaceState.update(choiceKey(hostId, sessionName), choice);
	}

	private onRegistryChanged(): void {
		const liveKeys = new Set<string>();
		for (const entry of this.registry.list()) {
			const key = `${entry.hostId}:${entry.sessionName}`;
			liveKeys.add(key);
			if (this.probing.has(key) || this.probed.has(key)) {
				continue;
			}
			// Per-session remembered choice wins — 'terminal' suppresses the auto-open.
			if (this.ctx.workspaceState.get<string>(choiceKey(entry.hostId, entry.sessionName)) === 'terminal') {
				this.probed.add(key);
				continue;
			}
			void this.probeAndMaybeOpen(entry.hostId, entry.sessionName);
		}
		// Drop probed entries for sessions that are no longer registered so a
		// close+reconnect of the same (host, session) re-probes correctly.
		for (const key of this.probed) {
			if (!liveKeys.has(key)) {
				this.probed.delete(key);
			}
		}
	}

	private async probeAndMaybeOpen(hostId: number, sessionName: string): Promise<void> {
		const key = `${hostId}:${sessionName}`;
		this.probing.add(key);
		try {
			// Per-session remembered choice wins — never yank a user who chose Terminal.
			if (this.ctx.workspaceState.get<string>(choiceKey(hostId, sessionName)) === 'terminal') {
				this.probed.add(key);
				return;
			}
			const pty = this.registry.getPty(hostId, sessionName);
			if (!pty) {
				return; // transient — not marked probed; will retry on next change.
			}
			// Wait briefly for the pty's tmux state to be ready so the active-pane
			// metadata reflects the real (post-startup) pane.
			const ready = await waitForPtyReady(pty, 4000);
			if (!ready) {
				return; // transient (pty not ready) — NOT marked probed; retries later.
			}
			const connection = this.connectionService
				? this.connectionService.getConnection(hostId) ?? (await getOrConnect(this.connectionService, hostId))
				: pty.getConnection();
			if (!connection) {
				return; // transient (no connection yet) — NOT marked probed; retries.
			}
			const ref = await attributeSurfaceSession(pty, connection);
			if (!ref) {
				// Stable result: pty was ready but no agent matched. Mark probed so we
				// don't keep re-probing a session that has no agent running.
				this.probed.add(key);
				return;
			}
			// Open the conversation as a SIBLING tab, revealed but not stealing focus
			// from the terminal (the user stays where they are).
			await vscode.commands.executeCommand('pocketshell.conversation.openForSession', {
				hostId,
				agentType: ref.agentType,
				sessionId: ref.id,
				viewColumn: vscode.ViewColumn.Beside,
			});
			this.probed.add(key);
			// Re-focus the terminal so the user is never yanked away.
			const entry = this.registry.get(hostId, sessionName);
			entry?.terminal.show(true);
		} catch {
			// Best-effort: never let the default-open path disrupt the terminal.
			// A thrown error is treated as transient — NOT marked probed, so it retries.
		} finally {
			this.probing.delete(key);
		}
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}
}

/** workspaceState key for a session's remembered default-view choice. */
function choiceKey(hostId: number, sessionName: string): string {
	return `pocketshell.conversationDefault.${hostId}:${sessionName}`;
}

/**
 * Resolve to true once the pty has a non-empty active-pane metadata (tmux state
 * is ready), or false after `timeoutMs` (best-effort transient; caller retries).
 */
async function waitForPtyReady(
	pty: import('../tmux-ui/tmux-session-terminal').TmuxSessionPseudoterminal,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const metadata = pty.getActivePaneMetadata();
			if (metadata && metadata.id) {
				return true;
			}
		} catch {
			// pty not ready yet — keep waiting
		}
		await delay(150);
	}
	return false;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
