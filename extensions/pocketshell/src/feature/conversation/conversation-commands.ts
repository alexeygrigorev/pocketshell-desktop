/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ConnectionService } from '../../connection-service';
import { getOrConnect, resolveHostId } from '../../host-picking';
import type { FeatureDeps } from '../manifest';
import type { ConversationAttributionResult } from '../../backend/agents';
import type { AgentType, ConversationMessage } from '../../backend/agents/conversation';
import {
	appendConversationMessage,
	createConversationPanelModel,
	createQuoteReplyPayload,
	messagePlainText,
	renderConversationHtml,
	sessionPlainText,
	SessionReader,
	type ConversationPanelModel,
	type QuoteReplyPayload,
} from '../../backend/agents/conversation';

interface ConversationPanelEntry {
	panel: vscode.WebviewPanel;
	model: ConversationPanelModel;
	reader: SessionReader;
	nonce: string;
	stopTail?: () => void;
}

export function registerConversation(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];
	const panels = new Map<string, ConversationPanelEntry>();

	disposables.push(
		vscode.commands.registerCommand('pocketshell.conversation.openActivePane', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const connection = await getOrConnect(service, hostId);
			if (!connection) {
				return;
			}

			const hint = await vscode.commands.executeCommand<ConversationAttributionResult | undefined>(
				'pocketshell.tmux-ui.getActivePaneConversationHint',
				element,
			);
			const sessionRef = await resolveAttributedSession(hint);
			if (!sessionRef) {
				return;
			}

			const key = `${hostId}:${sessionRef.agentType}:${sessionRef.id}`;
			const existing = panels.get(key);
			if (existing) {
				existing.panel.reveal(vscode.ViewColumn.Active);
				return;
			}

			try {
				const reader = new SessionReader(connection);
				const session = await reader.readSession(sessionRef.id, sessionRef.agentType);
				const model = createConversationPanelModel(session);
				const panel = vscode.window.createWebviewPanel(
					'pocketshell.conversation',
					vscode.l10n.t('Conversation: {0}', model.title),
					vscode.ViewColumn.Active,
					{
						enableScripts: true,
						retainContextWhenHidden: true,
					},
				);
				const entry: ConversationPanelEntry = { panel, model, reader, nonce: createNonce() };
				panels.set(key, entry);
				wirePanelMessages(panel, entry);
				renderPanel(entry);

				entry.stopTail = await startTail(reader, sessionRef.id, sessionRef.agentType, entry);
				panel.onDidDispose(() => {
					entry.stopTail?.();
					reader.dispose();
					panels.delete(key);
				}, null, disposables);
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Failed to open conversation: {0}', String(err)));
			}
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.conversation.quoteReply', async (payload?: QuoteReplyPayload) => {
			if (!payload) {
				return undefined;
			}
			await ctx.workspaceState.update('pocketshell.conversation.lastQuoteReply', payload);
			await vscode.env.clipboard.writeText(payload.quote);
			void vscode.window.showInformationMessage(vscode.l10n.t('Quoted message copied for reply.'));
			return payload;
		}),
	);

	disposables.push({
		dispose: () => {
			for (const entry of panels.values()) {
				entry.stopTail?.();
				entry.reader.dispose();
			}
			panels.clear();
		},
	});

	return disposables;
}

async function resolveAttributedSession(
	hint: ConversationAttributionResult | undefined,
): Promise<{ id: string; agentType: AgentType } | undefined> {
	const sessionRef = sessionRefFromAttribution(hint);
	if (sessionRef) {
		return sessionRef;
	}
	if (!hint || hint.kind === 'no-match') {
		void vscode.window.showWarningMessage(vscode.l10n.t('No agent conversation was detected for the active tmux pane.'));
		return undefined;
	}
	void vscode.window.showWarningMessage(vscode.l10n.t('Multiple agent conversations match the active tmux pane. Select the pane running the active agent session and try again.'));
	return undefined;
}

export function sessionRefFromAttribution(
	hint: ConversationAttributionResult | undefined,
): { id: string; agentType: AgentType } | undefined {
	if (hint?.kind === 'match' && hint.session) {
		return { id: hint.session.id, agentType: hint.session.agentType };
	}
	return undefined;
}

async function startTail(
	reader: SessionReader,
	sessionId: string,
	agentType: AgentType,
	entry: ConversationPanelEntry,
): Promise<() => void> {
	return reader.tailSession(sessionId, agentType, (message: ConversationMessage) => {
		entry.model = appendConversationMessage(entry.model, message);
		renderPanel(entry);
	});
}

function wirePanelMessages(panel: vscode.WebviewPanel, entry: ConversationPanelEntry): void {
	panel.webview.onDidReceiveMessage(async (message: { action?: string; messageId?: string }) => {
		if (message.action === 'copy-session') {
			await vscode.env.clipboard.writeText(sessionPlainText(entry.model));
			void vscode.window.showInformationMessage(vscode.l10n.t('Conversation copied to clipboard.'));
			return;
		}
		if (!message.messageId) {
			return;
		}
		const conversationMessage = entry.model.messages.find((m) => m.id === message.messageId);
		if (!conversationMessage) {
			return;
		}
		if (message.action === 'copy-message') {
			await vscode.env.clipboard.writeText(messagePlainText(conversationMessage));
			void vscode.window.showInformationMessage(vscode.l10n.t('Message copied to clipboard.'));
			return;
		}
		if (message.action === 'quote-reply') {
			const payload = createQuoteReplyPayload(entry.model, message.messageId);
			if (payload) {
				await vscode.commands.executeCommand('pocketshell.conversation.quoteReply', payload);
			}
		}
	});
}

function renderPanel(entry: ConversationPanelEntry): void {
	entry.panel.title = vscode.l10n.t('Conversation: {0}', entry.model.title);
	entry.panel.webview.html = renderConversationHtml(entry.model, {
		cspSource: entry.panel.webview.cspSource,
		nonce: entry.nonce,
	});
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}
