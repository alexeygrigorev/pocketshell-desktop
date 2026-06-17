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
import { AgentMessenger, ReplyQueue } from '../../backend/agents/reply';
import { registerConversationSidebar } from './conversation-sidebar-provider';
import {
	appendConversationMessage,
	clearConversationSearch,
	createConversationPanelModel,
	createQuoteReplyPayload,
	markComposerQueued,
	markComposerQueuedReplySent,
	markComposerSendFailed,
	markComposerSendSucceeded,
	markComposerSending,
	messagePlainText,
	navigateConversationSearch,
	quotePayloadTargetsPanel,
	renderConversationHtml,
	sessionPlainText,
	SessionReader,
	updateConversationComposer,
	updateConversationSearch,
	type ConversationPanelModel,
	type QuoteReplyPayload,
} from '../../backend/agents/conversation';

interface ConversationPanelEntry {
	key: string;
	hostId: number;
	panel: vscode.WebviewPanel;
	model: ConversationPanelModel;
	reader: SessionReader;
	messenger: AgentMessenger;
	queue: ReplyQueue;
	nonce: string;
	searchRenderTimer?: ReturnType<typeof setTimeout>;
	queueRenderTimer?: ReturnType<typeof setTimeout>;
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
				const messenger = new AgentMessenger(connection);
				const queue = new ReplyQueue(messenger);
				const entry: ConversationPanelEntry = { key, hostId, panel, model, reader, messenger, queue, nonce: createNonce() };
				panels.set(key, entry);
				wireQueue(entry);
				wirePanelMessages(panel, entry);
				renderPanel(entry);

				entry.stopTail = await startTail(reader, sessionRef.id, sessionRef.agentType, entry);
				panel.onDidDispose(() => {
					clearScheduledSearchRender(entry);
					clearScheduledQueueRender(entry);
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
			for (const entry of panels.values()) {
				if (quotePayloadTargetsPanel(payload, entry.key)) {
					void entry.panel.webview.postMessage({ action: 'composer-insert-quote', quote: payload.quote });
				}
			}
			void vscode.window.showInformationMessage(vscode.l10n.t('Quoted message copied for reply.'));
			return payload;
		}),
	);

	disposables.push({
		dispose: () => {
			for (const entry of panels.values()) {
				clearScheduledSearchRender(entry);
				clearScheduledQueueRender(entry);
				entry.stopTail?.();
				entry.reader.dispose();
			}
			panels.clear();
		},
	});

	disposables.push(...registerConversationSidebar(service, ctx, _deps));

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
		clearScheduledSearchRender(entry);
		renderPanel(entry);
	});
}

function wirePanelMessages(panel: vscode.WebviewPanel, entry: ConversationPanelEntry): void {
	panel.webview.onDidReceiveMessage(async (message: { action?: string; messageId?: string; query?: string; text?: string }) => {
		if (message.action === 'search-update') {
			entry.model = updateConversationSearch(entry.model, message.query ?? '');
			scheduleSearchRender(entry);
			return;
		}
		if (message.action === 'search-next') {
			entry.model = navigateConversationSearch(entry.model, 'next');
			clearScheduledSearchRender(entry);
			renderPanel(entry);
			return;
		}
		if (message.action === 'search-previous') {
			entry.model = navigateConversationSearch(entry.model, 'previous');
			clearScheduledSearchRender(entry);
			renderPanel(entry);
			return;
		}
		if (message.action === 'search-clear') {
			entry.model = clearConversationSearch(entry.model);
			clearScheduledSearchRender(entry);
			renderPanel(entry);
			return;
		}
		if (message.action === 'copy-session') {
			await vscode.env.clipboard.writeText(sessionPlainText(entry.model));
			void vscode.window.showInformationMessage(vscode.l10n.t('Conversation copied to clipboard.'));
			return;
		}
		if (message.action === 'open-prompt-composer') {
			await vscode.commands.executeCommand('pocketshell.promptComposer.open', {
				target: {
					kind: 'agent',
					hostId: entry.hostId,
					agentType: entry.model.agentType,
					sessionId: entry.model.sessionId,
					label: entry.model.title,
					panelKey: entry.key,
				},
			});
			return;
		}
		if (message.action === 'send-reply') {
			await sendComposerReply(entry, message.text ?? '');
			return;
		}
		if (message.action === 'queue-reply') {
			queueComposerReply(entry, message.text ?? '');
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
			const payload = createQuoteReplyPayload(entry.model, message.messageId, entry.key);
			if (payload) {
				await vscode.commands.executeCommand('pocketshell.conversation.quoteReply', payload);
			}
		}
	});
}

async function sendComposerReply(entry: ConversationPanelEntry, text: string): Promise<void> {
	const draft = text;
	entry.model = markComposerSending(entry.model);
	renderPanel(entry);

	const result = await entry.messenger.send(entry.model.sessionId, entry.model.agentType, draft);
	if (result.success) {
		entry.model = markComposerSendSucceeded(entry.model);
	} else {
		entry.model = markComposerSendFailed(entry.model, result.error ?? 'Unknown send failure', draft);
	}
	renderPanel(entry);
}

function queueComposerReply(entry: ConversationPanelEntry, text: string): void {
	if (!text.trim()) {
		entry.model = markComposerSendFailed(entry.model, 'Message must not be empty', text);
		renderPanel(entry);
		return;
	}

	entry.queue.enqueue(entry.model.sessionId, entry.model.agentType, text);
	entry.model = markComposerQueued(entry.model);
	syncQueueComposerStatus(entry);
	renderPanel(entry);
}

function wireQueue(entry: ConversationPanelEntry): void {
	entry.queue.onReplySent.listen(() => {
		entry.model = markComposerQueuedReplySent(entry.model);
		scheduleQueueStatusRender(entry);
	});
	entry.queue.onReplyFailed.listen(({ reply, error }) => {
		entry.model = markComposerSendFailed(entry.model, error.message, reply.message);
		scheduleQueueStatusRender(entry);
	});
}

function syncQueueComposerStatus(entry: ConversationPanelEntry): void {
	entry.model = updateConversationComposer(entry.model, {
		pendingCount: entry.queue.pending.length,
		isProcessing: entry.queue.isProcessing,
	});
}

function scheduleQueueStatusRender(entry: ConversationPanelEntry): void {
	clearScheduledQueueRender(entry);
	entry.queueRenderTimer = setTimeout(() => {
		entry.queueRenderTimer = undefined;
		syncQueueComposerStatus(entry);
		renderPanel(entry);
	}, 0);
}

function scheduleSearchRender(entry: ConversationPanelEntry): void {
	clearScheduledSearchRender(entry);
	entry.searchRenderTimer = setTimeout(() => {
		entry.searchRenderTimer = undefined;
		renderPanel(entry);
	}, 150);
}

function clearScheduledSearchRender(entry: ConversationPanelEntry): void {
	if (entry.searchRenderTimer) {
		clearTimeout(entry.searchRenderTimer);
		entry.searchRenderTimer = undefined;
	}
}

function clearScheduledQueueRender(entry: ConversationPanelEntry): void {
	if (entry.queueRenderTimer) {
		clearTimeout(entry.queueRenderTimer);
		entry.queueRenderTimer = undefined;
	}
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
