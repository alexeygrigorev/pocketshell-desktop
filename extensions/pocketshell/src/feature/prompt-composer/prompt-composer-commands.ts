/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ConnectionService } from '../../connection-service';
import { getOrConnect, resolveHostId } from '../../host-picking';
import type { FeatureDeps } from '../manifest';
import { AgentMessenger } from '../../backend/agents/reply';
import type { ConversationAttributionResult } from '../../backend/agents';
import type { QuoteReplyPayload } from '../../backend/agents/conversation';
import {
	buildInitialPromptDraft,
	buildPromptComposerDraftKey,
	createPromptComposerPanelModel,
	markPromptComposerFailed,
	markPromptComposerInserted,
	markPromptComposerInserting,
	markPromptComposerSending,
	markPromptComposerSent,
	normalizePromptComposerOpenArgs,
	quoteTargetsPromptComposer,
	renderPromptComposerHtml,
	type PromptComposerPaneTarget,
	type PromptComposerPanelModel,
	type PromptComposerTarget,
} from '../../backend/agents/prompt-composer';

interface PromptComposerPanelEntry {
	key: string;
	draftKey: string;
	panel: vscode.WebviewPanel;
	model: PromptComposerPanelModel;
	nonce: string;
	insertTarget?: PromptComposerPaneTarget;
}

interface ResolvedPromptComposerTarget {
	target: PromptComposerTarget;
	insertTarget?: PromptComposerPaneTarget;
}

export function registerPromptComposer(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];
	const panels = new Map<string, PromptComposerPanelEntry>();

	disposables.push(
		vscode.commands.registerCommand('pocketshell.promptComposer.open', async (element?: unknown) => {
			const args = normalizePromptComposerOpenArgs(element);
			const resolved = args.target
				? { target: args.target }
				: await resolveDefaultComposerTarget(element);
			if (!resolved) {
				void vscode.window.showWarningMessage(vscode.l10n.t('No agent session or tmux pane is available for the prompt composer.'));
				return undefined;
			}

			const target = await fillAgentHostId(service, resolved.target, element);
			if (!target) {
				return undefined;
			}
			const draftKey = buildPromptComposerDraftKey(target);
			const existing = panels.get(draftKey);
			const quoteText = await resolveQuoteText(ctx, target, args.quoteText, args.useLastQuote);
			const addition = buildInitialPromptDraft(undefined, { quoteText, prefillText: args.prefillText });
			if (existing) {
				existing.panel.reveal(vscode.ViewColumn.Active);
				if (addition.trim()) {
					void existing.panel.webview.postMessage({ action: 'insert-text', text: addition.trimEnd() });
				}
				return existing;
			}

			const storedDraft = ctx.workspaceState.get<string>(draftKey);
			const initialDraft = buildInitialPromptDraft(storedDraft, { quoteText, prefillText: args.prefillText });
			const panel = vscode.window.createWebviewPanel(
				'pocketshell.promptComposer',
				vscode.l10n.t('Prompt Composer'),
				vscode.ViewColumn.Active,
				{
					enableScripts: true,
					retainContextWhenHidden: true,
				},
			);
			const entry: PromptComposerPanelEntry = {
				key: draftKey,
				draftKey,
				panel,
				model: createPromptComposerPanelModel(target, initialDraft),
				nonce: createNonce(),
				insertTarget: resolved.insertTarget,
			};
			panels.set(draftKey, entry);
			wirePanelMessages(service, ctx, entry);
			renderPanel(entry);
			panel.onDidDispose(() => panels.delete(draftKey), null, disposables);
			return entry;
		}),
	);

	disposables.push({
		dispose: () => {
			for (const entry of panels.values()) {
				entry.panel.dispose();
			}
			panels.clear();
		},
	});

	return disposables;
}

function wirePanelMessages(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	entry: PromptComposerPanelEntry,
): void {
	entry.panel.webview.onDidReceiveMessage(async (message: { action?: string; text?: string }) => {
		if (message.action === 'draft-change') {
			await ctx.workspaceState.update(entry.draftKey, message.text ?? '');
			return;
		}
		if (message.action === 'send') {
			await sendPrompt(service, ctx, entry, message.text ?? '');
			return;
		}
		if (message.action === 'insert') {
			await insertPrompt(entry, message.text ?? '');
		}
	});
}

async function sendPrompt(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	entry: PromptComposerPanelEntry,
	text: string,
): Promise<void> {
	if (!text.trim()) {
		entry.model = markPromptComposerFailed(entry.model, 'Prompt must not be empty', text);
		renderPanel(entry);
		return;
	}

	entry.model = markPromptComposerSending(entry.model);
	renderPanel(entry);
	try {
		if (entry.model.target.kind === 'agent') {
			const hostId = entry.model.target.hostId;
			if (hostId === undefined) {
				throw new Error('No connected host is available for this agent session');
			}
			const connection = await getOrConnect(service, hostId);
			if (!connection) {
				throw new Error('SSH connection is not active');
			}
			const result = await new AgentMessenger(connection).send(
				entry.model.target.sessionId,
				entry.model.target.agentType,
				text,
			);
			if (!result.success) {
				throw new Error(result.error ?? 'Unknown send failure');
			}
		} else {
			const sent = await vscode.commands.executeCommand<boolean>('pocketshell.tmux-ui.sendTextToPane', entry.model.target, {
				text,
				submit: true,
			});
			if (sent !== true) {
				throw new Error('Failed to send text to tmux pane');
			}
		}
		await ctx.workspaceState.update(entry.draftKey, undefined);
		entry.model = markPromptComposerSent(entry.model);
	} catch (err) {
		entry.model = markPromptComposerFailed(entry.model, errorMessage(err), text);
	}
	renderPanel(entry);
}

async function insertPrompt(entry: PromptComposerPanelEntry, text: string): Promise<void> {
	if (!text.trim()) {
		entry.model = markPromptComposerFailed(entry.model, 'Prompt must not be empty', text);
		renderPanel(entry);
		return;
	}

	entry.model = markPromptComposerInserting(entry.model);
	renderPanel(entry);
	try {
		const target = entry.model.target.kind === 'pane' ? entry.model.target : entry.insertTarget;
		const inserted = await vscode.commands.executeCommand<boolean>('pocketshell.tmux-ui.sendTextToPane', target, {
			text,
			submit: false,
		});
		if (inserted !== true) {
			throw new Error('Failed to insert text into tmux pane');
		}
		entry.model = markPromptComposerInserted(entry.model);
	} catch (err) {
		entry.model = markPromptComposerFailed(entry.model, errorMessage(err), text);
	}
	renderPanel(entry);
}

async function resolveDefaultComposerTarget(element: unknown): Promise<ResolvedPromptComposerTarget | undefined> {
	const paneTarget = await vscode.commands.executeCommand<PromptComposerPaneTarget | undefined>(
		'pocketshell.tmux-ui.getPromptComposerPaneTarget',
		element,
	);
	const hint = await vscode.commands.executeCommand<ConversationAttributionResult | undefined>(
		'pocketshell.tmux-ui.getActivePaneConversationHint',
		paneTarget ?? element,
	);
	if (hint?.kind === 'match' && hint.session) {
		return {
			target: {
				kind: 'agent',
				hostId: paneTarget?.hostId,
				agentType: hint.session.agentType,
				sessionId: hint.session.id,
				label: `${hint.session.agentType}: ${hint.session.id}`,
				panelKey: paneTarget?.hostId !== undefined
					? `${paneTarget.hostId}:${hint.session.agentType}:${hint.session.id}`
					: undefined,
			},
			insertTarget: paneTarget,
		};
	}
	return paneTarget ? { target: paneTarget, insertTarget: paneTarget } : undefined;
}

async function fillAgentHostId(
	service: ConnectionService,
	target: PromptComposerTarget,
	element: unknown,
): Promise<PromptComposerTarget | undefined> {
	if (target.kind !== 'agent' || target.hostId !== undefined) {
		return target;
	}
	const hostId = await resolveHostId(service, element, { connectedOnly: true });
	if (hostId === undefined) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Select a connected host before opening an agent prompt composer.'));
		return undefined;
	}
	return {
		...target,
		hostId,
		panelKey: target.panelKey ?? `${hostId}:${target.agentType}:${target.sessionId}`,
	};
}

async function resolveQuoteText(
	ctx: vscode.ExtensionContext,
	target: PromptComposerTarget,
	explicitQuote: string | undefined,
	useLastQuote: boolean,
): Promise<string | undefined> {
	if (explicitQuote !== undefined) {
		return explicitQuote;
	}
	if (!useLastQuote) {
		return undefined;
	}
	const lastQuote = ctx.workspaceState.get<QuoteReplyPayload>('pocketshell.conversation.lastQuoteReply');
	return quoteTargetsPromptComposer(lastQuote, target) ? lastQuote?.quote : undefined;
}

function renderPanel(entry: PromptComposerPanelEntry): void {
	entry.panel.title = vscode.l10n.t('Prompt: {0}', entry.model.title);
	entry.panel.webview.html = renderPromptComposerHtml(entry.model, {
		cspSource: entry.panel.webview.cspSource,
		nonce: entry.nonce,
	});
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}
