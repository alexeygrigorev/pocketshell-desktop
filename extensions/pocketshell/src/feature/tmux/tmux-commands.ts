/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { TmuxClient, type CommandResponse } from '../../backend/tmux/client';
import { SshShellBridge } from '../../backend/tmux/ssh-shell-bridge';
import type { FeatureDeps } from '../manifest';

/**
 * tmux feature: registers read / mutate commands that drive a remote
 * {@link TmuxClient} over an SSH connection.
 *
 * Each command resolves a connected host, opens an interactive shell, wraps it
 * in an {@link SshShellBridge} (the `SshChannel` the tmux client expects), and
 * drives the tmux -CC control-mode API. The client is created per invocation
 * and closed (detaching the underlying shell) once the result is shown. A
 * single `PocketShell tmux` OutputChannel is reused across commands.
 */
export function registerTmux(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell tmux');
	disposables.push(output);

	// -------------------------------------------------------------------------
	// pocketshell.tmux.list — read: list tmux sessions on a host
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.tmux.list', async () => {
			const result = await withTmux(service, 'list-sessions', async (client) => {
				return client.listSessions();
			});
			if (result === undefined) {
				return;
			}
			renderResponse(output, 'list-sessions', result);
			output.show(true);
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.tmux.new — mutate: create a detached session
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.tmux.new', async () => {
			const name = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('New tmux session name'),
				value: 'pocketshell',
			});
			if (name === undefined) {
				return;
			}

			const result = await withTmux(service, `new-session ${name}`, async (client) => {
				return client.newSession(name);
			});
			if (result === undefined) {
				return;
			}
			if (result.isError) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('tmux new-session failed: {0}', result.output.join('\n')),
				);
			} else {
				vscode.window.showInformationMessage(
					vscode.l10n.t('Created tmux session {0}', name),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.tmux.send — mutate: send keystrokes to a pane
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.tmux.send', async () => {
			const paneId = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Target pane id (e.g. %0)'),
				validateInput: (v) =>
					v.startsWith('%') ? undefined : vscode.l10n.t('Pane id must start with %'),
			});
			if (paneId === undefined) {
				return;
			}
			const keys = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Keys to send'),
			});
			if (keys === undefined) {
				return;
			}

			const result = await withTmux(service, `send-keys ${paneId}`, async (client) => {
				return client.sendKeys(paneId, keys);
			});
			if (result === undefined) {
				return;
			}
			if (result.isError) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('tmux send-keys failed: {0}', result.output.join('\n')),
				);
			} else {
				vscode.window.showInformationMessage(
					vscode.l10n.t('Sent keys to {0}', paneId),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.tmux.detach — mutate: detach the control-mode client
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.tmux.detach', async () => {
			const detached = await withTmux(service, 'detach', async (client) => {
				await client.detach();
				return true;
			});
			if (detached === undefined) {
				return;
			}
			vscode.window.showInformationMessage(vscode.l10n.t('Detached from tmux.'));
		}),
	);

	return disposables;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Resolve a connected host, open a shell, wrap it, and run `fn` against a
 * freshly connected {@link TmuxClient}. The client is always detached/closed
 * after `fn` resolves or throws.
 *
 * @returns the value returned by `fn`, or `undefined` if the user cancelled
 *          the host pick, the connection failed, or tmux failed to start.
 */
async function withTmux<T>(
	service: ConnectionService,
	label: string,
	fn: (client: TmuxClient) => Promise<T>,
): Promise<T | undefined> {
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
	const client = new TmuxClient({ sessionName: 'pocketshell' });

	try {
		await client.connect(channel);
		return await fn(client);
	} catch (err) {
		vscode.window.showErrorMessage(
			vscode.l10n.t('tmux {0} failed: {1}', label, String(err)),
		);
		return undefined;
	} finally {
		// `detach` sends a clean detach-client and closes the channel; fall back
		// to a hard close if detach rejects (it is best-effort internally too).
		try {
			await client.detach();
		} catch {
			await client.close();
		}
	}
}

/** Render a tmux command response to the shared OutputChannel. */
function renderResponse(
	output: vscode.OutputChannel,
	label: string,
	response: CommandResponse,
): void {
	output.appendLine(`# tmux ${label}`);
	if (response.isError) {
		output.appendLine('## error');
	}
	for (const line of response.output) {
		output.appendLine(line);
	}
	output.appendLine('');
}
