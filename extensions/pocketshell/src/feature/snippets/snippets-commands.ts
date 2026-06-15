/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { pickHost } from '../../host-picking';
import type { FeatureDeps } from '../manifest';
import {
	SNIPPET_LIBRARY_STATE_KEY,
	SnippetValidationError,
	checkSnippetRunScope,
	deleteSnippet,
	expandSnippetBody,
	filterSnippetsByScope,
	getSnippet,
	parseSnippetLibrary,
	scopeLabel,
	type SnippetEntry,
	type SnippetInput,
	type SnippetKind,
	type SnippetScope,
	upsertSnippet,
} from '../../backend/agents/snippets';
import type { PromptComposerPaneTarget } from '../../backend/agents/prompt-composer';

type SnippetRunAction = 'insert-terminal' | 'send-terminal' | 'composer';

interface SnippetCommandArgs {
	snippetId?: string;
	action?: SnippetRunAction;
	element?: unknown;
}

interface SnippetRunTarget {
	element: unknown;
	paneTarget?: PromptComposerPaneTarget;
	verifiedHostId?: number;
	contextHostId?: number;
}

class SnippetWorkspaceStore {
	constructor(private readonly ctx: vscode.ExtensionContext) {}

	load(): SnippetEntry[] {
		return parseSnippetLibrary(this.ctx.workspaceState.get(SNIPPET_LIBRARY_STATE_KEY, []));
	}

	async save(library: readonly SnippetEntry[]): Promise<void> {
		await this.ctx.workspaceState.update(SNIPPET_LIBRARY_STATE_KEY, [...library]);
	}

	async upsert(input: SnippetInput): Promise<SnippetEntry> {
		const existing = this.load();
		const beforeIds = new Set(existing.map((snippet) => snippet.id));
		const next = upsertSnippet(existing, input);
		await this.save(next);
		if (input.id) {
			const updated = getSnippet(next, input.id);
			if (updated) {
				return updated;
			}
		}
		const saved = next.find((snippet) => !beforeIds.has(snippet.id))
			?? next.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
		if (!saved) {
			throw new Error('Snippet was not saved');
		}
		return saved;
	}

	async delete(snippetId: string): Promise<void> {
		await this.save(deleteSnippet(this.load(), snippetId));
	}
}

export function registerSnippets(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const store = new SnippetWorkspaceStore(ctx);
	const disposables: vscode.Disposable[] = [];

	disposables.push(
		vscode.commands.registerCommand('pocketshell.snippets.create', async () => {
			await createSnippet(service, store);
		}),
		vscode.commands.registerCommand('pocketshell.snippets.edit', async (args?: SnippetCommandArgs) => {
			await editSnippet(service, store, args?.snippetId);
		}),
		vscode.commands.registerCommand('pocketshell.snippets.delete', async (args?: SnippetCommandArgs) => {
			await deleteSnippetCommand(store, args?.snippetId);
		}),
		vscode.commands.registerCommand('pocketshell.snippets.list', async () => {
			await listSnippets(store);
		}),
		vscode.commands.registerCommand('pocketshell.snippets.manage', async () => {
			await manageSnippets(service, store);
		}),
		vscode.commands.registerCommand('pocketshell.snippets.insertTerminal', async (args?: SnippetCommandArgs | unknown) => {
			await runSnippet(store, normalizeRunArgs(args, 'insert-terminal'));
		}),
		vscode.commands.registerCommand('pocketshell.snippets.openComposer', async (args?: SnippetCommandArgs | unknown) => {
			await runSnippet(store, normalizeRunArgs(args, 'composer'));
		}),
		vscode.commands.registerCommand('pocketshell.snippets.run', async (args?: SnippetCommandArgs | string) => {
			await runSnippet(store, normalizeRunArgs(args));
		}),
	);

	return disposables;
}

async function createSnippet(service: ConnectionService, store: SnippetWorkspaceStore): Promise<void> {
	const input = await collectSnippetInput(service);
	if (!input) {
		return;
	}
	try {
		const snippet = await store.upsert(input);
		await refreshPaletteSnippets();
		void vscode.window.showInformationMessage(vscode.l10n.t('Created snippet "{0}".', snippet.name));
	} catch (err) {
		showSnippetError('Create snippet failed', err);
	}
}

async function editSnippet(
	service: ConnectionService,
	store: SnippetWorkspaceStore,
	snippetId?: string,
): Promise<void> {
	const snippet = snippetId ? getSnippet(store.load(), snippetId) : await pickSnippet(store.load(), 'Select snippet to edit');
	if (!snippet) {
		return;
	}
	const input = await collectSnippetInput(service, snippet);
	if (!input) {
		return;
	}
	try {
		await store.upsert({ ...input, id: snippet.id, createdAt: snippet.createdAt });
		await refreshPaletteSnippets();
		void vscode.window.showInformationMessage(vscode.l10n.t('Updated snippet "{0}".', input.name ?? snippet.name));
	} catch (err) {
		showSnippetError('Edit snippet failed', err);
	}
}

async function deleteSnippetCommand(store: SnippetWorkspaceStore, snippetId?: string): Promise<void> {
	const snippet = snippetId ? getSnippet(store.load(), snippetId) : await pickSnippet(store.load(), 'Select snippet to delete');
	if (!snippet) {
		return;
	}
	const deleteLabel = vscode.l10n.t('Delete');
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t('Delete snippet "{0}"?', snippet.name),
		{ modal: true },
		deleteLabel,
	);
	if (choice !== deleteLabel) {
		return;
	}
	await store.delete(snippet.id);
	await refreshPaletteSnippets();
	void vscode.window.showInformationMessage(vscode.l10n.t('Deleted snippet "{0}".', snippet.name));
}

async function listSnippets(store: SnippetWorkspaceStore): Promise<void> {
	const snippets = store.load();
	if (snippets.length === 0) {
		void vscode.window.showInformationMessage(vscode.l10n.t('No snippets or templates saved.'));
		return;
	}
	await vscode.window.showQuickPick(snippets.map(toSnippetPickItem), {
		placeHolder: vscode.l10n.t('{0} snippet/template(s)', String(snippets.length)),
		matchOnDescription: true,
		matchOnDetail: true,
	});
}

async function manageSnippets(service: ConnectionService, store: SnippetWorkspaceStore): Promise<void> {
	const create = { label: vscode.l10n.t('Create New Snippet'), description: vscode.l10n.t('Add a snippet or command template') };
	const picked = await vscode.window.showQuickPick([
		create,
		...store.load().map(toSnippetPickItem),
	], {
		placeHolder: vscode.l10n.t('Manage snippets and templates'),
		matchOnDescription: true,
		matchOnDetail: true,
	});
	if (!picked) {
		return;
	}
	if (picked === create) {
		await createSnippet(service, store);
		return;
	}
	const snippet = (picked as ReturnType<typeof toSnippetPickItem>).snippet;
	const action = await vscode.window.showQuickPick([
		{ label: vscode.l10n.t('Insert into Terminal'), value: 'insert-terminal' as const },
		{ label: vscode.l10n.t('Send to Terminal'), value: 'send-terminal' as const },
		{ label: vscode.l10n.t('Open in Composer'), value: 'composer' as const },
		{ label: vscode.l10n.t('Edit'), value: 'edit' as const },
		{ label: vscode.l10n.t('Delete'), value: 'delete' as const },
	], { placeHolder: vscode.l10n.t('Action for "{0}"', snippet.name) });
	if (!action) {
		return;
	}
	if (action.value === 'edit') {
		await editSnippet(service, store, snippet.id);
	} else if (action.value === 'delete') {
		await deleteSnippetCommand(store, snippet.id);
	} else {
		await runSnippet(store, { snippetId: snippet.id, action: action.value });
	}
}

async function runSnippet(store: SnippetWorkspaceStore, args: SnippetCommandArgs): Promise<void> {
	const library = store.load();
	let target: SnippetRunTarget | undefined;
	if (!args.snippetId) {
		target = await resolveSnippetRunTarget(args.element);
	}
	const snippet = args.snippetId
		? getSnippet(library, args.snippetId)
		: await pickSnippet(filterSnippetsByScope(library, {
			hostId: target?.verifiedHostId,
			includeGlobal: true,
		}), 'Select snippet or template');
	if (!snippet) {
		if (args.snippetId) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Snippet not found: {0}', args.snippetId));
		}
		return;
	}
	const action = args.action ?? await pickRunAction(snippet);
	if (!action) {
		return;
	}
	target = target ?? await resolveSnippetRunTarget(args.element);
	const scopeCheck = checkSnippetRunScope(snippet, target.verifiedHostId);
	if (!scopeCheck.allowed) {
		if (scopeCheck.reason === 'missing-host') {
			void vscode.window.showWarningMessage(
				vscode.l10n.t('Select a tmux pane on host {0} before running "{1}".', String(scopeCheck.expectedHostId), snippet.name),
			);
		} else {
			void vscode.window.showWarningMessage(
				vscode.l10n.t(
					'Snippet "{0}" is scoped to host {1}, but the selected pane is on host {2}.',
					snippet.name,
					String(scopeCheck.expectedHostId),
					String(scopeCheck.actualHostId),
				),
			);
		}
		return;
	}
	const targetElement = target.paneTarget ?? target.element;
	const hostId = target.contextHostId;
	const text = expandSnippetBody(snippet, {
		variables: {
			hostId: snippet.scope.type === 'host' ? snippet.scope.hostId : hostId,
		},
	});
	if (action === 'composer') {
		await vscode.commands.executeCommand('pocketshell.promptComposer.open', {
			...objectArg(targetElement),
			...(target.paneTarget ? { target: target.paneTarget } : {}),
			prefillText: text,
		});
		return;
	}
	const inserted = await vscode.commands.executeCommand<boolean>(
		'pocketshell.tmux-ui.sendTextToPane',
		targetElement,
		{ text, submit: action === 'send-terminal' },
	);
	if (inserted !== true) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Snippet was not inserted into a tmux pane.'));
	}
}

async function resolveSnippetRunTarget(element: unknown): Promise<SnippetRunTarget> {
	const contextHostId = hostIdFromElement(element);
	try {
		const paneTarget = await vscode.commands.executeCommand<PromptComposerPaneTarget | undefined>(
			'pocketshell.tmux-ui.getPromptComposerPaneTarget',
			element,
		);
		if (paneTarget) {
			return {
				element: paneTarget,
				paneTarget,
				verifiedHostId: paneTarget.hostId,
				contextHostId: paneTarget.hostId ?? contextHostId,
			};
		}
	} catch {
		// Fall back to the original command element; host-scoped snippets still
		// fail closed because only a resolved pane target counts as verified.
	}
	return {
		element,
		contextHostId,
	};
}

async function collectSnippetInput(
	service: ConnectionService,
	existing?: SnippetEntry,
): Promise<SnippetInput | undefined> {
	const name = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Snippet/template name'),
		value: existing?.name,
		validateInput: (value: string) => value.trim() ? undefined : vscode.l10n.t('Name is required'),
	});
	if (name === undefined) {
		return undefined;
	}
	const kindPick = await vscode.window.showQuickPick([
		{ label: vscode.l10n.t('Snippet'), value: 'snippet' as SnippetKind },
		{ label: vscode.l10n.t('Command Template'), value: 'template' as SnippetKind },
	], {
		placeHolder: vscode.l10n.t('Entry type'),
	});
	if (!kindPick) {
		return undefined;
	}
	const prefix = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Slash/prefix trigger'),
		value: existing?.prefix ?? name,
		validateInput: (value: string) => value.trim() ? undefined : vscode.l10n.t('Prefix is required'),
	});
	if (prefix === undefined) {
		return undefined;
	}
	const body = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Snippet/template text (use \\n for new lines)'),
		value: existing ? escapeNewlines(existing.body) : '',
		ignoreFocusOut: true,
		validateInput: (value: string) => value.trim() ? undefined : vscode.l10n.t('Text is required'),
	});
	if (body === undefined) {
		return undefined;
	}
	const description = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Description'),
		value: existing?.description,
	});
	if (description === undefined) {
		return undefined;
	}
	const tags = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Tags (comma separated)'),
		value: existing?.tags.join(', '),
	});
	if (tags === undefined) {
		return undefined;
	}
	const scope = await pickSnippetScope(service, existing?.scope);
	if (!scope) {
		return undefined;
	}
	return {
		name,
		kind: kindPick.value,
		prefix,
		body: unescapeNewlines(body),
		description,
		tags,
		scope,
	};
}

async function pickSnippetScope(service: ConnectionService, existing?: SnippetScope): Promise<SnippetScope | undefined> {
	const scope = await vscode.window.showQuickPick([
		{ label: vscode.l10n.t('Global'), value: 'global' as const, picked: existing?.type !== 'host' },
		{ label: vscode.l10n.t('Host'), value: 'host' as const, picked: existing?.type === 'host' },
	], { placeHolder: vscode.l10n.t('Snippet scope') });
	if (!scope) {
		return undefined;
	}
	if (scope.value === 'global') {
		return { type: 'global' };
	}
	const hostId = await pickHost(service);
	return hostId === undefined ? undefined : { type: 'host', hostId };
}

async function pickRunAction(snippet: SnippetEntry): Promise<SnippetRunAction | undefined> {
	const picked = await vscode.window.showQuickPick([
		{ label: vscode.l10n.t('Insert into Terminal'), value: 'insert-terminal' as const },
		{ label: vscode.l10n.t('Send to Terminal'), value: 'send-terminal' as const },
		{ label: vscode.l10n.t('Open in Composer'), value: 'composer' as const },
	], { placeHolder: vscode.l10n.t('Run "{0}"', snippet.name) });
	return picked?.value;
}

async function pickSnippet(
	snippets: readonly SnippetEntry[],
	placeHolder: string,
): Promise<SnippetEntry | undefined> {
	if (snippets.length === 0) {
		void vscode.window.showInformationMessage(vscode.l10n.t('No snippets or templates saved.'));
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(snippets.map(toSnippetPickItem), {
		placeHolder: vscode.l10n.t(placeHolder),
		matchOnDescription: true,
		matchOnDetail: true,
	});
	return picked?.snippet;
}

function toSnippetPickItem(snippet: SnippetEntry): vscode.QuickPickItem & { snippet: SnippetEntry } {
	return {
		label: snippet.name,
		description: `${snippet.prefix} - ${snippet.kind} - ${scopeLabel(snippet.scope)}`,
		detail: snippet.description ?? snippet.body,
		snippet,
	};
}

function normalizeRunArgs(args: SnippetCommandArgs | string | unknown, action?: SnippetRunAction): SnippetCommandArgs {
	if (typeof args === 'string') {
		return { snippetId: args, action };
	}
	if (args && typeof args === 'object' && ('snippetId' in args || 'action' in args || 'element' in args)) {
		return { ...(args as SnippetCommandArgs), action: action ?? (args as SnippetCommandArgs).action };
	}
	return { action, element: args };
}

function hostIdFromElement(element: unknown): number | undefined {
	if (!element || typeof element !== 'object') {
		return undefined;
	}
	const value = element as Record<string, unknown>;
	return typeof value.hostId === 'number' ? value.hostId : undefined;
}

function objectArg(element: unknown): Record<string, unknown> {
	return element && typeof element === 'object' ? element as Record<string, unknown> : {};
}

function escapeNewlines(value: string): string {
	return value.replace(/\n/g, '\\n');
}

function unescapeNewlines(value: string): string {
	return value.replace(/\\n/g, '\n');
}

async function refreshPaletteSnippets(): Promise<void> {
	try {
		await vscode.commands.executeCommand('pocketshell.palette.refreshSnippets');
	} catch {
		// Palette may not be registered yet; it also refreshes snippets when opened.
	}
}

function showSnippetError(prefix: string, err: unknown): void {
	const message = err instanceof SnippetValidationError || err instanceof Error ? err.message : String(err);
	void vscode.window.showErrorMessage(vscode.l10n.t('{0}: {1}', prefix, message));
}
