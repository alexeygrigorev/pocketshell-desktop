/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import type { SessionTerminalRegistry } from '../surface/session-terminal-registry';
import type { TmuxSessionRegistry } from '../tmux-ui/tmux-session-registry';
import type { TmuxSessionPseudoterminal } from '../tmux-ui/tmux-session-terminal';
import type { Host } from '../../backend/ssh/data/host-store';

/**
 * Resolves the "active session" for the assistant's `get_context` /
 * `run_command` / `send_prompt_to_session` tools (orchestrator decision #2).
 *
 * Concept (desktop-only adaptation of the app's SessionActionBridge): track
 * `vscode.window.onDidChangeActiveTerminal` and remember the last active
 * PocketShell terminal — one backed by a SessionTerminalRegistry or
 * TmuxSessionRegistry entry. When the assistant needs an active session, we:
 *
 *  1. Try the last-active PocketShell terminal (if still open).
 *  2. Fall back to the first registered surface session.
 *  3. Fall back to the first registered tmux-ui session.
 *  4. Fall back to the first connected host (no terminal — used for the SSH
 *     exec-backed inspect tools like list_directory / read_file).
 *
 * Kept in the feature layer (NOT mirrored): it depends on vscode + the live
 * registries. Disposed via the returned Disposable[] (lesson #20).
 */
export interface ActiveSession {
	readonly hostId: number;
	readonly hostLabel: string;
	readonly sessionName: string | null;
	readonly pty: TmuxSessionPseudoterminal | null;
}

export class ActiveSessionResolver implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	/** The last terminal the user focused that we recognise as ours. */
	private lastTerminal: vscode.Terminal | null = null;

	constructor(
		private readonly connectionService: ConnectionService,
		private readonly surfaceRegistry: SessionTerminalRegistry | undefined,
		private readonly tmuxRegistry: TmuxSessionRegistry | undefined,
	) {
		// Remember the active terminal whenever it changes, so get_context can
		// resolve "this session" without a round-trip. We don't filter here —
		// resolveActive() validates that the terminal is one of ours.
		this.disposables.push(
			vscode.window.onDidChangeActiveTerminal((terminal) => {
				this.lastTerminal = terminal ?? this.lastTerminal;
			}),
		);
	}

	/**
	 * Resolve the current active session, or null when no PocketShell terminal
	 * is open and no host is connected. Used by get_context + the mutating tools.
	 */
	async resolveActive(): Promise<ActiveSession | null> {
		// 1. Last-active surface session terminal.
		if (this.surfaceRegistry && this.lastTerminal) {
			const entry = this.findSurfaceEntryByTerminal(this.lastTerminal);
			if (entry) {
				const pty = this.surfaceRegistry.getPty(entry.hostId, entry.sessionName) ?? null;
				return { hostId: entry.hostId, hostLabel: entry.hostLabel, sessionName: entry.sessionName, pty: pty ?? null };
			}
		}
		// 2. First registered surface session.
		if (this.surfaceRegistry) {
			const first = this.surfaceRegistry.list()[0];
			if (first) {
				const pty = this.surfaceRegistry.getPty(first.hostId, first.sessionName) ?? null;
				return { hostId: first.hostId, hostLabel: first.hostLabel, sessionName: first.sessionName, pty: pty ?? null };
			}
		}
		// 3. First registered tmux-ui session.
		if (this.tmuxRegistry) {
			const first = this.tmuxRegistry.entries()[0];
			if (first) {
				return {
					hostId: first.hostId,
					hostLabel: first.hostLabel,
					sessionName: first.sessionName,
					pty: first.pty,
				};
			}
		}
		// 4. First connected host (no terminal — used by SSH-exec inspect tools).
		const host = await this.firstConnectedHost();
		if (host) {
			return { hostId: host.id, hostLabel: host.name, sessionName: null, pty: null };
		}
		return null;
	}

	/** The first connected host (by ConnectionService state), or null. */
	async firstConnectedHost(): Promise<Host | null> {
		const hosts = await this.connectionService.getHosts();
		for (const host of hosts) {
			const conn = this.connectionService.getConnection(host.id);
			if (conn && conn.connected) {
				return host;
			}
		}
		return null;
	}

	/** Look up a host by id (live-resolved from ~/.ssh/config). */
	async getHostById(hostId: number): Promise<Host | undefined> {
		return this.connectionService.getHost(hostId);
	}

	/** All saved hosts. */
	async listHosts(): Promise<Host[]> {
		return this.connectionService.getHosts();
	}

	private findSurfaceEntryByTerminal(terminal: vscode.Terminal) {
		if (!this.surfaceRegistry) return undefined;
		return this.surfaceRegistry.list().find((entry) => entry.terminal === terminal);
	}

	dispose(): void {
		for (const d of this.disposables) d.dispose();
		this.disposables.length = 0;
		this.lastTerminal = null;
	}
}
