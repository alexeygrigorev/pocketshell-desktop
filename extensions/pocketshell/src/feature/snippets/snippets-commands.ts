/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ConnectionService } from '../../connection-service';
import { pickHost } from '../../host-picking';
import type { FeatureDeps } from '../manifest';
import {
	COMMAND_TEMPLATE_LIBRARY_STATE_KEY,
	SNIPPET_LIBRARY_STATE_KEY,
	SnippetValidationError,
	checkSnippetRunScope,
	deleteCommandTemplate,
	deleteSnippet,
	expandCommandTemplateLines,
	expandSnippetBody,
	extractPlaceholderNames,
	filterSnippetsByScope,
	getCommandTemplate,
	getSnippet,
	parseCommandTemplateLibrary,
	parseSnippetLibrary,
	scopeLabel,
	splitCommandLines,
	upsertCommandTemplate,
	upsertSnippet,
	type CommandTemplateEntry,
	type CommandTemplateInput,
	type SnippetEntry,
	type SnippetInput,
	type SnippetKind,
	type SnippetScope,
} from '../../backend/agents/snippets';
import {
	buildSnippetsPanelModel,
	renderSnippetsPanelHtml,
	type SnippetsPanelScopeDescriptor,
	type SnippetsPanelTab,
} from '../../backend/ui/snippets';
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

/**
 * Client-local snippet + macro library store.
 *
 * Uses VS Code `globalState` (cross-workspace, client-local — matches the
 * Android app's Room DB). Migrated from `workspaceState`: on first load we
 * read any legacy `workspaceState` value and lift it into `globalState` so
 * existing users do not lose their libraries (orchestrator decision #2).
 */
class SnippetLibraryStore {
	constructor(private readonly ctx: vscode.ExtensionContext) {}

	loadSnippets(): SnippetEntry[] {
		this.migrateFromWorkspaceState();
		return parseSnippetLibrary(this.ctx.globalState.get(SNIPPET_LIBRARY_STATE_KEY, []));
	}

	loadMacros(): CommandTemplateEntry[] {
		return parseCommandTemplateLibrary(this.ctx.globalState.get(COMMAND_TEMPLATE_LIBRARY_STATE_KEY, []));
	}

	async saveSnippets(library: readonly SnippetEntry[]): Promise<void> {
		await this.ctx.globalState.update(SNIPPET_LIBRARY_STATE_KEY, [...library]);
	}

	async saveMacros(library: readonly CommandTemplateEntry[]): Promise<void> {
		await this.ctx.globalState.update(COMMAND_TEMPLATE_LIBRARY_STATE_KEY, [...library]);
	}

	async upsertSnippet(input: SnippetInput): Promise<SnippetEntry> {
		const existing = this.loadSnippets();
		const beforeIds = new Set(existing.map((snippet) => snippet.id));
		const next = upsertSnippet(existing, input);
		await this.saveSnippets(next);
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

	async upsertMacro(input: CommandTemplateInput): Promise<CommandTemplateEntry> {
		const existing = this.loadMacros();
		const beforeIds = new Set(existing.map((t) => t.id));
		const next = upsertCommandTemplate(existing, input);
		await this.saveMacros(next);
		if (input.id) {
			const updated = getCommandTemplate(next, input.id);
			if (updated) {
				return updated;
			}
		}
		const saved = next.find((t) => !beforeIds.has(t.id))
			?? next.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
		if (!saved) {
			throw new Error('Command template was not saved');
		}
		return saved;
	}

	async deleteSnippet(snippetId: string): Promise<void> {
		await this.saveSnippets(deleteSnippet(this.loadSnippets(), snippetId));
	}

	async deleteMacro(id: string): Promise<void> {
		await this.saveMacros(deleteCommandTemplate(this.loadMacros(), id));
	}

	/**
	 * One-time migration: lift any legacy `workspaceState` snippet library into
	 * `globalState`. Idempotent — once `globalState` has a value (even `[]`),
	 * the workspaceState copy is ignored. Safe to call on every load.
	 */
	private migrateFromWorkspaceState(): void {
		const legacyKey = SNIPPET_LIBRARY_STATE_KEY;
		const hasGlobal = this.ctx.globalState.get(legacyKey, undefined) !== undefined;
		const legacy = this.ctx.workspaceState.get<unknown[]>(legacyKey);
		if (!hasGlobal && Array.isArray(legacy) && legacy.length > 0) {
			void this.ctx.globalState.update(legacyKey, legacy);
		}
	}
}

export function registerSnippets(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const store = new SnippetLibraryStore(ctx);
	const disposables: vscode.Disposable[] = [];

	// One rich panel — reused across invocations (no per-host panels, since
	// snippets/macros live client-local and the panel shows all scopes).
	let panelEntry: SnippetsPanelEntry | undefined;

	disposables.push(
		vscode.commands.registerCommand('pocketshell.snippets.openPanel', async (args?: { tab?: SnippetsPanelTab } | unknown) => {
			const tab = isTabArgs(args) ? args.tab : undefined;
			await openSnippetsPanel(service, store, () => panelEntry, (entry) => { panelEntry = entry; }, () => { panelEntry = undefined; }, tab);
		}),
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
		// Macro (CommandTemplate) CRUD — app feature-parity §5.
		vscode.commands.registerCommand('pocketshell.snippets.macros.create', async () => {
			await createMacro(service, store);
		}),
		vscode.commands.registerCommand('pocketshell.snippets.macros.edit', async (args?: MacroCommandArgs) => {
			await editMacro(service, store, args?.id);
		}),
		vscode.commands.registerCommand('pocketshell.snippets.macros.delete', async (args?: MacroCommandArgs) => {
			await deleteMacroCommand(store, args?.id);
		}),
		vscode.commands.registerCommand('pocketshell.snippets.macros.run', async (args?: MacroCommandArgs | string) => {
			await runMacro(store, normalizeMacroRunArgs(args));
		}),
	);

	return disposables;
}

async function createSnippet(service: ConnectionService, store: SnippetLibraryStore, defaultKind?: SnippetKind): Promise<void> {
	const input = await collectSnippetInput(service, undefined, defaultKind);
	if (!input) {
		return;
	}
	try {
		const snippet = await store.upsertSnippet(input);
		await refreshPaletteSnippets();
		void vscode.window.showInformationMessage(vscode.l10n.t('Created snippet "{0}".', snippet.name));
	} catch (err) {
		showSnippetError('Create snippet failed', err);
	}
}

async function editSnippet(
	service: ConnectionService,
	store: SnippetLibraryStore,
	snippetId?: string,
): Promise<void> {
	const snippet = snippetId ? getSnippet(store.loadSnippets(), snippetId) : await pickSnippet(store.loadSnippets(), 'Select snippet to edit');
	if (!snippet) {
		return;
	}
	const input = await collectSnippetInput(service, snippet);
	if (!input) {
		return;
	}
	try {
		await store.upsertSnippet({ ...input, id: snippet.id, createdAt: snippet.createdAt });
		await refreshPaletteSnippets();
		void vscode.window.showInformationMessage(vscode.l10n.t('Updated snippet "{0}".', input.name ?? snippet.name));
	} catch (err) {
		showSnippetError('Edit snippet failed', err);
	}
}

async function deleteSnippetCommand(store: SnippetLibraryStore, snippetId?: string): Promise<void> {
	const snippet = snippetId ? getSnippet(store.loadSnippets(), snippetId) : await pickSnippet(store.loadSnippets(), 'Select snippet to delete');
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
	await store.deleteSnippet(snippet.id);
	await refreshPaletteSnippets();
	void vscode.window.showInformationMessage(vscode.l10n.t('Deleted snippet "{0}".', snippet.name));
}

async function listSnippets(store: SnippetLibraryStore): Promise<void> {
	const snippets = store.loadSnippets();
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

async function manageSnippets(service: ConnectionService, store: SnippetLibraryStore): Promise<void> {
	const create = { label: vscode.l10n.t('Create New Snippet'), description: vscode.l10n.t('Add a snippet or command template') };
	const picked = await vscode.window.showQuickPick([
		create,
		...store.loadSnippets().map(toSnippetPickItem),
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

async function runSnippet(store: SnippetLibraryStore, args: SnippetCommandArgs): Promise<void> {
	const library = store.loadSnippets();
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
	// Placeholder dialog (app feature-parity §5): if the body contains
	// {{name}} placeholders, prompt once per unique name before sending.
	const placeholderValues = await collectPlaceholderValues(snippet.body, {
		hostId: snippet.scope.type === 'host' ? snippet.scope.hostId : hostId,
	});
	if (placeholderValues === undefined) {
		return; // user cancelled the placeholder dialog
	}
	const text = expandSnippetBody(snippet, { variables: placeholderValues });
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
	defaultKind?: SnippetKind,
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
		{ label: vscode.l10n.t('Snippet'), value: 'snippet' as SnippetKind, picked: (existing?.kind ?? defaultKind) !== 'template' },
		{ label: vscode.l10n.t('Command Template'), value: 'template' as SnippetKind, picked: (existing?.kind ?? defaultKind) === 'template' },
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

// ---------------------------------------------------------------------------
// Placeholder dialog (app feature-parity §5)
// ---------------------------------------------------------------------------

/**
 * Prompt the user for each unique `{{name}}` placeholder in `body`. Returns a
 * variables map keyed by placeholder name, or `undefined` if the user cancelled
 * any prompt. The `builtIn` map (e.g. hostId) is always pre-populated so
 * placeholders matching built-in names resolve without a prompt.
 */
async function collectPlaceholderValues(
	body: string,
	builtIn: Record<string, string | number | boolean | undefined> = {},
): Promise<Record<string, string | number | boolean | undefined> | undefined> {
	const names = extractPlaceholderNames(body);
	const values: Record<string, string | number | boolean | undefined> = { ...builtIn };
	for (const name of names) {
		if (name in values) {
			continue; // built-in or already collected
		}
		const entered = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Value for "{0}"', name),
			validateInput: (v: string) => (v.trim() ? undefined : vscode.l10n.t('Value is required')),
		});
		if (entered === undefined) {
			return undefined; // cancelled
		}
		values[name] = entered;
	}
	return values;
}

// ---------------------------------------------------------------------------
// Snippets webview panel (app feature-parity §5: Prompts/Commands/Macros)
// ---------------------------------------------------------------------------

interface SnippetsPanelEntry {
	panel: vscode.WebviewPanel;
	nonce: string;
	tab: SnippetsPanelTab;
	search: string;
	scope?: SnippetsPanelScopeDescriptor;
}

interface SnippetsPanelMessage {
	action?: 'refresh' | 'switchTab' | 'search' | 'send' | 'edit' | 'delete' | 'add';
	tab?: SnippetsPanelTab;
	search?: string;
	id?: string;
	submit?: boolean;
	/** 'snippet' for prompts/commands rows, 'macro' for macros rows. */
	kind?: 'snippet' | 'macro';
}

function isTabArgs(args: unknown): args is { tab: SnippetsPanelTab } {
	if (!args || typeof args !== 'object' || !('tab' in args)) {
		return false;
	}
	const tab = (args as { tab: unknown }).tab;
	return tab === 'prompts' || tab === 'commands' || tab === 'macros';
}

async function openSnippetsPanel(
	service: ConnectionService,
	store: SnippetLibraryStore,
	getEntry: () => SnippetsPanelEntry | undefined,
	setEntry: (entry: SnippetsPanelEntry) => void,
	clearEntry: () => void,
	tab?: SnippetsPanelTab,
): Promise<void> {
	let entry = getEntry();
	if (!entry) {
		const panel = vscode.window.createWebviewPanel(
			'pocketshell.snippets',
			vscode.l10n.t('Snippets'),
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);
		entry = {
			panel,
			nonce: createNonce(),
			tab: tab ?? 'prompts',
			search: '',
		};
		setEntry(entry);

		// Lesson #20: push webview subscriptions into a Disposable[] and
		// dispose them in onDidDispose. NEVER pass the panel as Event's 3rd arg.
		const webviewDisposables: vscode.Disposable[] = [];
		webviewDisposables.push(
			panel.webview.onDidReceiveMessage(async (message: SnippetsPanelMessage) => {
				const current = getEntry();
				if (current) {
					await handleSnippetsPanelMessage(message, service, store, current);
				}
			}),
		);
		panel.onDidDispose(() => {
			for (const d of webviewDisposables) {
				d.dispose();
			}
			clearEntry();
		});
	}
	if (tab && entry.tab !== tab) {
		entry.tab = tab;
	}
	await renderSnippetsPanel(service, store, entry);
	entry.panel.reveal(vscode.ViewColumn.Active, true);
}

async function renderSnippetsPanel(
	_service: ConnectionService,
	store: SnippetLibraryStore,
	entry: SnippetsPanelEntry,
	status?: { tone: 'success' | 'error' | 'warning' | 'info' | undefined; message?: string },
): Promise<void> {
	const snippets = store.loadSnippets();
	const macros = store.loadMacros();
	const model = buildSnippetsPanelModel({
		snippets,
		macros,
		tab: entry.tab,
		search: entry.search,
		scope: entry.scope,
		status: status?.tone && status.message
			? { tone: status.tone, message: status.message }
			: undefined,
	});
	entry.panel.webview.html = renderSnippetsPanelHtml(model, {
		cspSource: entry.panel.webview.cspSource,
		nonce: entry.nonce,
	});
}

async function handleSnippetsPanelMessage(
	message: SnippetsPanelMessage,
	service: ConnectionService,
	store: SnippetLibraryStore,
	entry: SnippetsPanelEntry,
): Promise<void> {
	const { action } = message;
	if (!action) {
		return;
	}
	try {
		if (action === 'refresh') {
			await renderSnippetsPanel(service, store, entry);
			return;
		}
		if (action === 'switchTab') {
			if (message.tab) {
				entry.tab = message.tab;
			}
			await renderSnippetsPanel(service, store, entry);
			return;
		}
		if (action === 'search') {
			entry.search = message.search ?? '';
			await renderSnippetsPanel(service, store, entry);
			return;
		}
		if (action === 'add') {
			const tab = message.tab ?? entry.tab;
			if (tab === 'macros') {
				await createMacro(service, store);
			} else {
				// Default the kind to match the active tab.
				await createSnippet(service, store, tab === 'commands' ? 'template' : 'snippet');
			}
			await renderSnippetsPanel(service, store, entry);
			return;
		}
		if (action === 'edit') {
			if (!message.id) {
				throw new Error('Missing id');
			}
			if (message.kind === 'macro') {
				await editMacro(service, store, message.id);
			} else {
				await editSnippet(service, store, message.id);
			}
			await renderSnippetsPanel(service, store, entry);
			return;
		}
		if (action === 'delete') {
			if (!message.id) {
				throw new Error('Missing id');
			}
			if (message.kind === 'macro') {
				await store.deleteMacro(message.id);
			} else {
				await store.deleteSnippet(message.id);
			}
			await refreshPaletteSnippets();
			await renderSnippetsPanel(service, store, entry, { tone: 'success', message: 'Deleted' });
			return;
		}
		if (action === 'send') {
			if (!message.id) {
				throw new Error('Missing id');
			}
			const submit = message.submit === true;
			if (message.kind === 'macro') {
				await sendMacro(store, message.id, submit);
			} else {
				await sendSnippet(store, message.id, submit);
			}
			return;
		}
	} catch (err) {
		await renderSnippetsPanel(service, store, entry, { tone: 'error', message: errorMessage(err) });
	}
}

async function sendSnippet(store: SnippetLibraryStore, snippetId: string, submit: boolean): Promise<void> {
	const snippet = getSnippet(store.loadSnippets(), snippetId);
	if (!snippet) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Snippet not found: {0}', snippetId));
		return;
	}
	const placeholderValues = await collectPlaceholderValues(snippet.body);
	if (placeholderValues === undefined) {
		return;
	}
	const text = expandSnippetBody(snippet, { variables: placeholderValues });
	const inserted = await vscode.commands.executeCommand<boolean>(
		'pocketshell.tmux-ui.sendTextToPane',
		undefined,
		{ text, submit },
	);
	if (inserted !== true) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Snippet was not inserted into a tmux pane.'));
	}
}

async function sendMacro(store: SnippetLibraryStore, macroId: string, submit: boolean): Promise<void> {
	const macro = getCommandTemplate(store.loadMacros(), macroId);
	if (!macro) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Macro not found: {0}', macroId));
		return;
	}
	const placeholderValues = await collectPlaceholderValues(macro.commands);
	if (placeholderValues === undefined) {
		return;
	}
	const lines = expandCommandTemplateLines(macro, placeholderValues);
	for (const line of lines) {
		const inserted = await vscode.commands.executeCommand<boolean>(
			'pocketshell.tmux-ui.sendTextToPane',
			undefined,
			{ text: line, submit },
		);
		if (inserted !== true) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Macro line was not inserted into a tmux pane.'));
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Macro (CommandTemplate) CRUD
// ---------------------------------------------------------------------------

interface MacroCommandArgs {
	id?: string;
	element?: unknown;
}

async function createMacro(service: ConnectionService, store: SnippetLibraryStore): Promise<void> {
	const input = await collectMacroInput(service);
	if (!input) {
		return;
	}
	try {
		const macro = await store.upsertMacro(input);
		void vscode.window.showInformationMessage(vscode.l10n.t('Created macro "{0}".', macro.name));
	} catch (err) {
		showSnippetError('Create macro failed', err);
	}
}

async function editMacro(
	service: ConnectionService,
	store: SnippetLibraryStore,
	id?: string,
): Promise<void> {
	const macro = id ? getCommandTemplate(store.loadMacros(), id) : await pickMacro(store.loadMacros(), 'Select macro to edit');
	if (!macro) {
		return;
	}
	const input = await collectMacroInput(service, macro);
	if (!input) {
		return;
	}
	try {
		await store.upsertMacro({ ...input, id: macro.id, createdAt: macro.createdAt });
		void vscode.window.showInformationMessage(vscode.l10n.t('Updated macro "{0}".', input.name ?? macro.name));
	} catch (err) {
		showSnippetError('Edit macro failed', err);
	}
}

async function deleteMacroCommand(store: SnippetLibraryStore, id?: string): Promise<void> {
	const macro = id ? getCommandTemplate(store.loadMacros(), id) : await pickMacro(store.loadMacros(), 'Select macro to delete');
	if (!macro) {
		return;
	}
	const deleteLabel = vscode.l10n.t('Delete');
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t('Delete macro "{0}"?', macro.name),
		{ modal: true },
		deleteLabel,
	);
	if (choice !== deleteLabel) {
		return;
	}
	await store.deleteMacro(macro.id);
	void vscode.window.showInformationMessage(vscode.l10n.t('Deleted macro "{0}".', macro.name));
}

async function runMacro(store: SnippetLibraryStore, args: MacroCommandArgs): Promise<void> {
	const library = store.loadMacros();
	const macro = args.id ? getCommandTemplate(library, args.id) : await pickMacro(library, 'Select macro to run');
	if (!macro) {
		return;
	}
	const submit = await vscode.window.showQuickPick([
		{ label: vscode.l10n.t('Send each line + Enter'), value: true },
		{ label: vscode.l10n.t('Insert lines (no Enter)'), value: false },
	], { placeHolder: vscode.l10n.t('Run "{0}"', macro.name) });
	if (submit === undefined) {
		return;
	}
	await sendMacro(store, macro.id, submit.value);
}

async function pickMacro(
	macros: readonly CommandTemplateEntry[],
	placeHolder: string,
): Promise<CommandTemplateEntry | undefined> {
	if (macros.length === 0) {
		void vscode.window.showInformationMessage(vscode.l10n.t('No macros saved.'));
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(macros.map((macro) => ({
		label: macro.name,
		description: `${splitCommandLines(macro.commands).length} line(s) - ${scopeLabel(macro.scope)}`,
		detail: macro.description ?? splitCommandLines(macro.commands)[0] ?? '',
		macro,
	} satisfies vscode.QuickPickItem & { macro: CommandTemplateEntry })), {
		placeHolder: vscode.l10n.t(placeHolder),
		matchOnDescription: true,
		matchOnDetail: true,
	});
	return picked?.macro;
}

async function collectMacroInput(
	service: ConnectionService,
	existing?: CommandTemplateEntry,
): Promise<CommandTemplateInput | undefined> {
	const name = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Macro name'),
		value: existing?.name,
		validateInput: (value: string) => value.trim() ? undefined : vscode.l10n.t('Name is required'),
	});
	if (name === undefined) {
		return undefined;
	}
	const commands = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Commands (one per line; use \\n for new lines)'),
		value: existing ? escapeNewlines(existing.commands) : '',
		ignoreFocusOut: true,
		validateInput: (value: string) => value.trim() ? undefined : vscode.l10n.t('Commands are required'),
	});
	if (commands === undefined) {
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
		commands: unescapeNewlines(commands),
		description,
		tags,
		scope,
	};
}

function normalizeMacroRunArgs(args: MacroCommandArgs | string | unknown): MacroCommandArgs {
	if (typeof args === 'string') {
		return { id: args };
	}
	if (args && typeof args === 'object' && ('id' in args || 'element' in args)) {
		return args as MacroCommandArgs;
	}
	return { element: args };
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
