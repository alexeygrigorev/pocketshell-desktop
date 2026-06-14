/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { AgentMessenger, ReplyQueue } from '../../backend/agents/reply';
import type { AgentType, ReplyResult } from '../../backend/agents/reply';
import type { FeatureDeps } from '../manifest';

/**
 * Reply feature: registers commands that send messages to running AI coding
 * agent sessions over SSH, either as a one-shot send or enqueued through a
 * serialized ReplyQueue.
 *
 * A single `PocketShell Reply` OutputChannel is reused across commands and
 * disposed together with the registered commands. Each send/queue command
 * prompts for the session id, agent type, and message text.
 */
export function registerReply(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Reply');
	disposables.push(output);

	// -------------------------------------------------------------------------
	// pocketshell.reply.send — one-shot send to a running agent
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.reply.send', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const sessionId = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Agent session id'),
			});
			if (sessionId === undefined) {
				return;
			}

			const agentType = await pickAgentType();
			if (agentType === undefined) {
				return;
			}

			const message = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Message to send'),
			});
			if (message === undefined) {
				return;
			}

			try {
				const result = await new AgentMessenger(conn).send(sessionId, agentType, message);
				renderResult(output, sessionId, agentType, result);
				output.show(true);
				if (!result.success) {
					vscode.window.showErrorMessage(
						vscode.l10n.t('Reply failed: {0}', result.error ?? 'unknown error'),
					);
				} else {
					vscode.window.showInformationMessage(
						vscode.l10n.t('Reply sent to {0} session', agentType),
					);
				}
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Reply send failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.reply.queue — enqueue a reply for serialized sending
	// -------------------------------------------------------------------------
	// One queue per connection, cached so repeated enqueues accumulate.
	const queues = new Map<number, ReplyQueue>();

	disposables.push(
		vscode.commands.registerCommand('pocketshell.reply.queue', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const sessionId = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Agent session id'),
			});
			if (sessionId === undefined) {
				return;
			}

			const agentType = await pickAgentType();
			if (agentType === undefined) {
				return;
			}

			const message = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Message to enqueue'),
			});
			if (message === undefined) {
				return;
			}

			const queue = queues.get(hostId) ?? new ReplyQueue(new AgentMessenger(conn));
			queues.set(hostId, queue);
			queue.enqueue(sessionId, agentType, message);

			vscode.window.showInformationMessage(
				vscode.l10n.t(
					'Reply queued ({0} pending)',
					String(queue.pending.length),
				),
			);
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.reply.status — show current queue state
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.reply.status', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}

			const queue = queues.get(hostId);
			renderQueueStatus(output, hostId, queue);
			output.show(true);
		}),
	);

	return disposables;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const AGENT_TYPES: { label: string; agentType: AgentType }[] = [
	{ label: 'Claude', agentType: 'claude' },
	{ label: 'Codex', agentType: 'codex' },
	{ label: 'OpenCode', agentType: 'opencode' },
];

/** Quick-pick an agent type. Returns undefined if cancelled. */
async function pickAgentType(): Promise<AgentType | undefined> {
	const picked = await vscode.window.showQuickPick(
		AGENT_TYPES.map((a) => ({ label: a.label, agentType: a.agentType })),
		{ placeHolder: vscode.l10n.t('Select agent type') },
	);
	return picked?.agentType;
}

/** Render a ReplyResult to the shared OutputChannel. */
function renderResult(
	output: vscode.OutputChannel,
	sessionId: string,
	agentType: AgentType,
	result: ReplyResult,
): void {
	output.appendLine(`# reply send — ${agentType} @ ${sessionId}`);
	if (result.success) {
		output.appendLine('status: sent');
		if (result.agentResponse) {
			output.appendLine(`response: ${result.agentResponse}`);
		}
	} else {
		output.appendLine(`status: failed — ${result.error ?? 'unknown error'}`);
	}
	output.appendLine('');
}

/** Render the current queue state to the shared OutputChannel. */
function renderQueueStatus(
	output: vscode.OutputChannel,
	hostId: number,
	queue: ReplyQueue | undefined,
): void {
	output.appendLine(`# reply queue status — host ${hostId}`);
	if (!queue) {
		output.appendLine('no queue initialized for this host');
		output.appendLine('');
		return;
	}
	output.appendLine(
		`processing: ${queue.isProcessing ? 'yes' : 'no'}, pending: ${queue.pending.length}`,
	);
	for (const reply of queue.pending) {
		output.appendLine(
			`  ${reply.agentType} @ ${reply.sessionId}: ${truncate(reply.message)}`,
		);
	}
	output.appendLine('');
}

/** Truncate a message for single-line status display. */
function truncate(message: string, max = 60): string {
	const oneLine = message.replace(/\n/g, ' ').trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
