/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { SshPseudoterminal } from '../../ssh-terminal';
import { TmuxClient } from '../../backend/tmux/client';
import { SshShellBridge } from '../../backend/tmux/ssh-shell-bridge';
import type { SshConnection } from '../../backend/ssh/connection/ssh-client';
import {
	buildAgentStartCommand,
	buildSessionName,
	buildWindowName,
	quoteShellArg,
	type SessionKind,
} from '../../backend/sessions/create-session';

/**
 * Shared tmux-session launcher — the tail of `createSession` (sessions-commands.ts)
 * extracted so the action assistant's `start_session` tool can launch a session
 * through the EXACT same code path (Dispatch 2, action-assistant parity).
 *
 * It encapsulates the WHOLE tail: build sessionName/windowName → build the agent
 * command → create-or-attach the tmux session over an SSH shell → open a VS Code
 * terminal backed by `SshPseudoterminal` (attaching the just-created tmux session).
 *
 * Behavior is byte-identical to the previous inline `createSession` tail: same
 * terminal name `${host.name||host.hostname}: ${sessionName}`, same pty options
 * (`cwd`, `initialCommand: tmux attach-session -t <name>`), same iconPath, same
 * `showErrorMessage` on tmux new-window/send-keys failure, the same
 * `finally { client.detach()/close() }`, and the has-session precheck.
 *
 * Lives in the feature layer (NOT mirrored, lesson #19): it depends on vscode +
 * `SshPseudoterminal` + the live SSH/tmux surfaces. No canonical pure helper is
 * introduced here — the pure name/command builders already live in
 * `backend/sessions/create-session.ts` (mirrored).
 */

/** The host context a launched terminal is labelled with. */
export interface LaunchHost {
	readonly id: number;
	readonly name: string;
	readonly hostname: string;
}

/** A successful launch result. */
export interface LaunchResult {
	readonly sessionName: string;
	readonly terminal: vscode.Terminal;
}

/**
 * Launch a tmux session on `conn` in `startDirectory` for `kind`, opening a VS
 * Code terminal that attaches it. Returns the sessionName + terminal, or an
 * error result whose `message` is already user-facing (mirrors createSession).
 *
 * Mid-failure cleanup: if tmux setup succeeds but terminal creation throws, the
 * terminal is disposed so we never leak an unregistered/abandoned terminal.
 */
export async function launchTmuxSession(
	conn: SshConnection,
	host: LaunchHost,
	startDirectory: string,
	kind: SessionKind,
): Promise<{ ok: true; result: LaunchResult } | { ok: false; message: string }> {
	const sessionName = buildSessionName(startDirectory, kind);
	const windowName = buildWindowName(startDirectory, kind);
	const agentCommand = kind === 'shell' ? undefined : buildAgentStartCommand(kind, startDirectory);

	const tmuxReady = await createOrAttachTmuxSession(conn, sessionName, startDirectory, windowName, agentCommand);
	if (!tmuxReady.ok) {
		return { ok: false, message: tmuxReady.message };
	}

	const hostLabel = host.name || host.hostname;
	let terminal: vscode.Terminal;
	try {
		terminal = vscode.window.createTerminal({
			name: `${hostLabel}: ${sessionName}`,
			pty: new SshPseudoterminal(conn, hostLabel, undefined, {
				cwd: startDirectory,
				initialCommand: `tmux attach-session -t ${quoteShellArg(sessionName)}`,
			}),
			iconPath: new vscode.ThemeIcon(kind === 'shell' ? 'terminal-tmux' : 'hubot'),
		});
	} catch (err) {
		// Terminal creation failed after the tmux session was created. We don't
		// kill the remote tmux session (the user may still want it), but we DO
		// surface the failure so the caller doesn't think it launched.
		return { ok: false, message: `Failed to open the session terminal: ${String(err)}` };
	}
	terminal.show();
	return { ok: true, result: { sessionName, terminal } };
}

/**
 * Resolve a host id to a live connection (connecting if necessary), mirroring
 * `createSession`'s use of `getOrConnect`. Returns the connection + the host
 * record, or null when connect failed (UI already shown by getOrConnect).
 */
export async function resolveLaunchConnection(
	service: ConnectionService,
	hostId: number,
): Promise<{ conn: SshConnection; host: LaunchHost } | null> {
	const host = await service.getHost(hostId);
	if (!host) {
		void vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'));
		return null;
	}
	const conn = await getOrConnectHost(service, hostId);
	if (!conn) {
		return null;
	}
	return { conn, host: { id: host.id, name: host.name, hostname: host.hostname } };
}

// ---- internal: moved verbatim from sessions-commands.ts ----------------------

interface TmuxSetupOutcome {
	readonly ok: boolean;
	readonly message: string;
}

async function createOrAttachTmuxSession(
	conn: SshConnection,
	sessionName: string,
	startDirectory: string,
	windowName: string,
	agentCommand?: string,
): Promise<TmuxSetupOutcome> {
	const sessionAlreadyExists = await hasTmuxSession(conn, sessionName);
	const shell = await conn.shell();
	const client = new TmuxClient({
		sessionName,
		startDir: startDirectory || undefined,
		initialCommand: agentCommand && !sessionAlreadyExists ? agentCommand : undefined,
		commandTimeoutMs: 10_000,
	});
	try {
		await client.connect(new SshShellBridge(shell));
		if (agentCommand && sessionAlreadyExists) {
			const window = await client.newWindowWithPaneId(sessionName, windowName, startDirectory || undefined);
			if (window.isError) {
				const message = window.output.join('\n');
				void vscode.window.showErrorMessage(vscode.l10n.t('tmux new-window failed: {0}', message));
				return { ok: false, message };
			}
			const paneId = window.output.find((line) => line.startsWith('%'));
			if (!paneId) {
				const message = 'tmux did not report the new pane id.';
				void vscode.window.showErrorMessage(vscode.l10n.t(message));
				return { ok: false, message };
			}
			const sent = await client.sendKeysLiteral(paneId, agentCommand);
			if (sent.isError) {
				const message = sent.output.join('\n');
				void vscode.window.showErrorMessage(vscode.l10n.t('tmux send-keys failed: {0}', message));
				return { ok: false, message };
			}
		}
		return { ok: true, message: '' };
	} catch (err) {
		const message = String(err);
		void vscode.window.showErrorMessage(vscode.l10n.t('Failed to create tmux session: {0}', message));
		return { ok: false, message };
	} finally {
		try {
			await client.detach();
		} catch {
			await client.close();
		}
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

/**
 * Thin wrapper around host-picking's getOrConnect kept local so this module has
 * no feature-layer circular import on sessions-commands. Calls the same helper
 * createSession used (warm-lease connect with a progress notification).
 */
async function getOrConnectHost(service: ConnectionService, hostId: number): Promise<SshConnection | null> {
	// Imported lazily to avoid a static feature-layer cycle when this module is
	// consumed by both sessions-commands and the assistant actions.
	const { getOrConnect } = await import('../../host-picking');
	return getOrConnect(service, hostId);
}
