/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { exec } from 'child_process';
import * as https from 'https';
import type { ConnectionService } from '../../connection-service';
import { getOrConnect, resolveHostId } from '../../host-picking';
import type { FeatureDeps } from '../manifest';
import { AgentMessenger } from '../../backend/agents/reply';
import type { ConversationAttributionResult } from '../../backend/agents';
import type { QuoteReplyPayload } from '../../backend/agents/conversation';
import { SftpClient } from '../../backend/files/sftp-client';
import { registerPromptComposerSidebar, type PromptComposerSidebarProvider } from './prompt-composer-sidebar-provider';
import {
	addPromptComposerAttachments,
	appendPromptComposerTranscript,
	buildInitialPromptDraft,
	buildPromptComposerDraftKey,
	buildPromptComposerPromptText,
	canResolvePromptComposerPaneHostFromTarget,
	createPromptComposerDictationProvider,
	createPromptComposerPanelModel,
	getPromptComposerDictationAvailability,
	markPromptComposerAttachmentError,
	markPromptComposerAttachmentUploaded,
	markPromptComposerAttachmentUploading,
	markPromptComposerFailed,
	markPromptComposerInserted,
	markPromptComposerInserting,
	markPromptComposerSending,
	markPromptComposerSent,
	normalizePromptComposerOpenArgs,
	planPromptComposerAttachmentRemotePath,
	promptComposerPaneTargetsMatchRequest,
	quoteTargetsPromptComposer,
	readPromptComposerDictationConfig,
	removePromptComposerAttachment,
	renderPromptComposerHtml,
	resolvePromptComposerInsertTarget,
	type PromptComposerAttachment,
	type PromptComposerAttachmentInput,
	type PromptComposerDictationConfig,
	type PromptComposerDictationRequest,
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

/**
 * The live prompt-composer sidebar provider instance, captured during
 * registration so the E2E TestBridge (#90) can read its model. Undefined
 * until `registerPromptComposer` has run (and after a theoretical re-register).
 */
let promptComposerSidebarProvider: PromptComposerSidebarProvider | undefined;

/** Test-only accessor for the live prompt-composer sidebar provider (#90). */
export function getPromptComposerSidebarProvider(): PromptComposerSidebarProvider | undefined {
	return promptComposerSidebarProvider;
}

export function registerPromptComposer(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
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

			const target = await fillTargetHostId(service, resolved.target, element);
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
				model: createPromptComposerPanelModel(target, initialDraft, {
					dictationEnabled: getPromptComposerDictationAvailability(
						readPromptComposerDictationConfig(deps.getSettings?.(), process.env),
					).enabled,
				}),
				nonce: createNonce(),
				insertTarget: resolved.insertTarget,
			};
			panels.set(draftKey, entry);
			wirePanelMessages(service, ctx, deps, entry);
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

	const sidebar = registerPromptComposerSidebar(service, ctx, deps);
	disposables.push(...sidebar.disposables);
	promptComposerSidebarProvider = sidebar.provider;

	return disposables;
}

function wirePanelMessages(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
	entry: PromptComposerPanelEntry,
): void {
	entry.panel.webview.onDidReceiveMessage(async (message: { action?: string; text?: string; attachmentId?: string }) => {
		if (message.action === 'draft-change') {
			await ctx.workspaceState.update(entry.draftKey, message.text ?? '');
			return;
		}
		if (message.action === 'attach-files') {
			await attachFiles(service, entry);
			return;
		}
		if (message.action === 'dictate') {
			await dictatePrompt(ctx, deps, entry, message.text ?? '');
			return;
		}
		if (message.action === 'remove-attachment' && message.attachmentId) {
			entry.model = removePromptComposerAttachment(entry.model, message.attachmentId);
			renderPanel(entry);
			return;
		}
		if (message.action === 'send') {
			await sendPrompt(service, ctx, entry, message.text ?? '');
			return;
		}
		if (message.action === 'insert') {
			await insertPrompt(service, entry, message.text ?? '');
		}
	});
}

async function sendPrompt(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	entry: PromptComposerPanelEntry,
	text: string,
): Promise<void> {
	await uploadPendingAttachments(service, entry);
	const promptText = buildPromptTextOrFail(entry, text);
	if (promptText === undefined) {
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
				promptText,
			);
			if (!result.success) {
				throw new Error(result.error ?? 'Unknown send failure');
			}
		} else {
			const sent = await vscode.commands.executeCommand<boolean>('pocketshell.tmux-ui.sendTextToPane', entry.model.target, {
				text: promptText,
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

async function insertPrompt(service: ConnectionService, entry: PromptComposerPanelEntry, text: string): Promise<void> {
	const insertResolution = resolvePromptComposerInsertTarget(entry.model.target, entry.insertTarget);
	if (!insertResolution.target) {
		entry.model = markPromptComposerFailed(entry.model, insertResolution.error ?? 'Insert target is not available', text);
		renderPanel(entry);
		return;
	}

	await uploadPendingAttachments(service, entry);
	const promptText = buildPromptTextOrFail(entry, text);
	if (promptText === undefined) {
		renderPanel(entry);
		return;
	}

	entry.model = markPromptComposerInserting(entry.model);
	renderPanel(entry);
	try {
		const inserted = await vscode.commands.executeCommand<boolean>('pocketshell.tmux-ui.sendTextToPane', insertResolution.target, {
			text: promptText,
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

async function dictatePrompt(
	ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
	entry: PromptComposerPanelEntry,
	currentDraft: string,
): Promise<void> {
	const config = readPromptComposerDictationConfig(deps.getSettings?.(), process.env);
	const provider = createPromptComposerDictationProvider(config, {
		runCommand: runDictationCommand,
		transcribeOpenAi: transcribeOpenAiAudio,
	});
	if (!provider) {
		const availability = getPromptComposerDictationAvailability(config);
		void vscode.window.showWarningMessage(vscode.l10n.t(availability.reason ?? 'Dictation is not configured.'));
		return;
	}

	try {
		const transcript = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t('Transcribing dictation...'),
			cancellable: false,
		}, () => provider.transcribe());
		if (!transcript.trim()) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Dictation did not return any transcript text.'));
			return;
		}
		await ctx.workspaceState.update(entry.draftKey, appendPromptComposerTranscript(currentDraft, transcript));
		void entry.panel.webview.postMessage({ action: 'insert-text', text: transcript });
	} catch (err) {
		void vscode.window.showErrorMessage(vscode.l10n.t('Dictation failed: {0}', errorMessage(err)));
	}
}

async function attachFiles(service: ConnectionService, entry: PromptComposerPanelEntry): Promise<void> {
	const uris = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: true,
		openLabel: vscode.l10n.t('Attach'),
		title: vscode.l10n.t('Attach files to prompt'),
	});
	if (!uris?.length) {
		return;
	}

	const files = await Promise.all(uris.map(async (uri): Promise<PromptComposerAttachmentInput> => {
		let size: number | undefined;
		try {
			size = (await vscode.workspace.fs.stat(uri)).size;
		} catch {
			size = undefined;
		}
		return {
			id: createAttachmentId(),
			localPath: uri.fsPath,
			displayName: uri.path.split('/').filter(Boolean).pop() ?? uri.fsPath,
			size,
		};
	}));
	entry.model = addPromptComposerAttachments(entry.model, files);
	renderPanel(entry);
	await uploadPendingAttachments(service, entry);
}

async function runDictationCommand(command: string, request?: PromptComposerDictationRequest): Promise<string> {
	return new Promise((resolve, reject) => {
		exec(command, {
			env: {
				...process.env,
				...(request?.audioPath ? { PROMPT_COMPOSER_DICTATION_AUDIO_PATH: request.audioPath } : {}),
			},
			maxBuffer: 10 * 1024 * 1024,
		}, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr.trim() || error.message));
				return;
			}
			resolve(stdout);
		});
	});
}

async function transcribeOpenAiAudio(
	request: PromptComposerDictationRequest,
	config: PromptComposerDictationConfig,
): Promise<string> {
	const audio = request.audioData
		? Buffer.from(request.audioData)
		: await readDictationAudioFile(request.audioPath);
	const filename = request.fileName ?? basenameFromPath(request.audioPath) ?? 'dictation.wav';
	const mimeType = request.mimeType ?? mimeTypeFromAudioFileName(filename);
	const body = buildOpenAiTranscriptionBody({
		audio,
		filename,
		mimeType,
		model: config.openAiModel ?? 'whisper-1',
		language: config.language,
	});
	const response = await postOpenAiTranscription(body, config.openAiApiKey ?? '');
	const transcript = parseOpenAiTranscript(response);
	if (!transcript) {
		throw new Error('OpenAI transcription response did not include text');
	}
	return transcript;
}

async function readDictationAudioFile(audioPath?: string): Promise<Buffer> {
	const path = audioPath ?? await pickDictationAudioPath();
	const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
	return Buffer.from(data);
}

async function pickDictationAudioPath(): Promise<string> {
	const uris = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		openLabel: vscode.l10n.t('Transcribe'),
		title: vscode.l10n.t('Select audio file for dictation'),
		filters: {
			Audio: ['wav', 'mp3', 'm4a', 'mp4', 'mpeg', 'mpga', 'webm'],
		},
	});
	if (!uris?.[0]) {
		throw new Error('No audio file selected');
	}
	return uris[0].fsPath;
}

function buildOpenAiTranscriptionBody(options: {
	audio: Buffer;
	filename: string;
	mimeType: string;
	model: string;
	language?: string;
}): { body: Buffer; boundary: string } {
	const boundary = `----pocketshell-${randomBytes(12).toString('hex')}`;
	const parts: Buffer[] = [
		multipartField(boundary, 'model', options.model),
	];
	if (options.language) {
		parts.push(multipartField(boundary, 'language', options.language));
	}
	parts.push(Buffer.from(
		`--${boundary}\r\n`
		+ `Content-Disposition: form-data; name="file"; filename="${escapeMultipartValue(options.filename)}"\r\n`
		+ `Content-Type: ${options.mimeType}\r\n\r\n`,
		'utf8',
	));
	parts.push(options.audio);
	parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
	return { body: Buffer.concat(parts), boundary };
}

function multipartField(boundary: string, name: string, value: string): Buffer {
	return Buffer.from(
		`--${boundary}\r\n`
		+ `Content-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n`
		+ `${value}\r\n`,
		'utf8',
	);
}

async function postOpenAiTranscription(
	payload: { body: Buffer; boundary: string },
	apiKey: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = https.request('https://api.openai.com/v1/audio/transcriptions', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': `multipart/form-data; boundary=${payload.boundary}`,
				'Content-Length': payload.body.length,
			},
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			res.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
					reject(new Error(`OpenAI transcription failed (${res.statusCode ?? 'unknown'}): ${body}`));
					return;
				}
				resolve(body);
			});
		});
		req.on('error', reject);
		req.write(payload.body);
		req.end();
	});
}

function parseOpenAiTranscript(body: string): string {
	try {
		const parsed = JSON.parse(body) as { text?: unknown };
		return typeof parsed.text === 'string' ? parsed.text.trim() : '';
	} catch {
		return '';
	}
}

function basenameFromPath(path: string | undefined): string | undefined {
	return path?.split(/[\\/]/).filter(Boolean).pop();
}

function mimeTypeFromAudioFileName(filename: string): string {
	const ext = filename.split('.').pop()?.toLowerCase();
	if (ext === 'mp3' || ext === 'mpeg' || ext === 'mpga') {
		return 'audio/mpeg';
	}
	if (ext === 'm4a' || ext === 'mp4') {
		return 'audio/mp4';
	}
	if (ext === 'webm') {
		return 'audio/webm';
	}
	return 'audio/wav';
}

function escapeMultipartValue(value: string): string {
	return value.replace(/["\r\n]/g, '_');
}

async function uploadPendingAttachments(service: ConnectionService, entry: PromptComposerPanelEntry): Promise<void> {
	const pending = entry.model.attachments.filter((attachment) => (
		attachment.status === 'staged' || attachment.status === 'error'
	));
	if (pending.length === 0) {
		return;
	}

	const hostId = entry.model.target.hostId;
	if (hostId === undefined) {
		const message = entry.model.target.kind === 'pane'
			? 'No connected host is available for this tmux pane'
			: 'No connected host is available for this agent session';
		for (const attachment of pending) {
			entry.model = markPromptComposerAttachmentError(entry.model, attachment.id, message);
		}
		renderPanel(entry);
		return;
	}

	try {
		const connection = await getOrConnect(service, hostId);
		if (!connection) {
			for (const attachment of pending) {
				entry.model = markPromptComposerAttachmentError(entry.model, attachment.id, 'SSH connection is not active');
			}
			renderPanel(entry);
			return;
		}

		const sftp = new SftpClient(connection);
		try {
			await sftp.connect();
			const remoteHome = await sftp.realpath('.');
			for (const attachment of pending) {
				await uploadAttachment(entry, sftp, remoteHome, attachment);
			}
		} finally {
			sftp.disconnect();
		}
	} catch (err) {
		for (const attachment of pending) {
			entry.model = markPromptComposerAttachmentError(entry.model, attachment.id, errorMessage(err));
		}
		renderPanel(entry);
	}
}

async function uploadAttachment(
	entry: PromptComposerPanelEntry,
	sftp: SftpClient,
	remoteHome: string,
	attachment: PromptComposerAttachment,
): Promise<void> {
	const plan = planPromptComposerAttachmentRemotePath(entry.model.target, attachment, { remoteHome });
	entry.model = markPromptComposerAttachmentUploading(entry.model, attachment.id, plan.remotePath);
	renderPanel(entry);
	try {
		await ensureRemoteDirectory(sftp, plan.stagingDirectory);
		const data = await vscode.workspace.fs.readFile(vscode.Uri.file(attachment.localPath));
		await sftp.writeFile(plan.remotePath, Buffer.from(data));
		entry.model = markPromptComposerAttachmentUploaded(entry.model, attachment.id, plan.remotePath);
	} catch (err) {
		entry.model = markPromptComposerAttachmentError(entry.model, attachment.id, errorMessage(err));
	}
	renderPanel(entry);
}

async function ensureRemoteDirectory(sftp: SftpClient, remoteDirectory: string): Promise<void> {
	const isAbsolute = remoteDirectory.startsWith('/');
	const parts = remoteDirectory.split('/').filter(Boolean);
	let current = isAbsolute ? '' : '.';
	for (const part of parts) {
		current = current === ''
			? `/${part}`
			: `${current.replace(/\/$/, '')}/${part}`;
		if (await sftp.exists(current)) {
			continue;
		}
		await sftp.mkdir(current);
	}
}

function buildPromptTextOrFail(entry: PromptComposerPanelEntry, text: string): string | undefined {
	try {
		const promptText = buildPromptComposerPromptText(text, entry.model.attachments);
		if (!promptText.trim()) {
			entry.model = markPromptComposerFailed(entry.model, 'Prompt must not be empty', text);
			return undefined;
		}
		return promptText;
	} catch (err) {
		entry.model = markPromptComposerFailed(entry.model, errorMessage(err), text);
		return undefined;
	}
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

async function fillTargetHostId(
	service: ConnectionService,
	target: PromptComposerTarget,
	element: unknown,
): Promise<PromptComposerTarget | undefined> {
	if (target.hostId !== undefined) {
		return target;
	}
	if (target.kind === 'pane') {
		const resolved = await resolvePaneTargetHostId(target);
		if (!resolved) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Open the prompt composer from a known tmux pane before attaching files.'));
			return undefined;
		}
		return resolved;
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

async function resolvePaneTargetHostId(target: PromptComposerPaneTarget): Promise<PromptComposerPaneTarget | undefined> {
	if (!canResolvePromptComposerPaneHostFromTarget(target)) {
		return undefined;
	}
	const resolved = await vscode.commands.executeCommand<PromptComposerPaneTarget | undefined>(
		'pocketshell.tmux-ui.getPromptComposerPaneTarget',
		target,
	);
	if (!resolved || resolved.hostId === undefined || !promptComposerPaneTargetsMatchRequest(target, resolved)) {
		return undefined;
	}
	return {
		...target,
		hostId: resolved.hostId,
		entryId: target.entryId ?? resolved.entryId,
		paneId: target.paneId ?? resolved.paneId,
		label: target.label ?? resolved.label,
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

function createAttachmentId(): string {
	return `att-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}
