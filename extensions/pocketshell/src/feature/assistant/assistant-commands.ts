/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import type { FeatureDeps } from '../manifest';
import type { SessionTerminalRegistry } from '../surface/session-terminal-registry';
import type { TmuxSessionRegistry } from '../tmux-ui/tmux-session-registry';
import type {
	AssistantLlmClient,
	Candidate,
	ChoiceDecision,
	ChoiceGate,
	ConfirmGate,
	Decision,
	Outcome,
} from '../../backend/assistant';
import type { FolderCandidate } from '../../backend/assistant/folder-resolver';
import { AssistantAgentLoop } from '../../backend/assistant';
import { DesktopAssistantActions } from './desktop-assistant-actions';
import {
	loadAssistantSettings,
	loadProviderConfig,
	saveApiKey,
} from './assistant-config-store';
import { OpenAiLlmClient } from '../../backend/assistant/openai-llm-client';

/**
 * Registers the assistant feature commands (orchestrator decision #6):
 *
 *  - `pocketshell.assistant.ask` — showInputBox for the transcript, then run
 *    the agent loop wrapped in `withProgress({location: Notification})`.
 *  - `pocketshell.assistant.configure` — open settings / prompt for provider+key.
 *
 * The confirm-gate UX is BUILT here (orchestrator decision #5):
 *  - mutating candidate -> showQuickPick([Approve, Edit...])
 *  - Edit -> showInputBox (empty/dismiss = Cancel)
 *  - No `kind` QuickPick discriminator (lesson #13).
 *
 * The gate won't TRIGGER in Dispatch 1 because mutating actions short-circuit
 * to the stub before reaching the gate. Dispatch 2 fills in the mutating impls.
 *
 * Returns a `vscode.Disposable[]` capturing the terminal-tracker + command
 * disposables (lesson #20); all are disposed on extension deactivation.
 */
export function registerAssistant(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const surfaceRegistry = deps.surfaceSessionRegistry as SessionTerminalRegistry | undefined;
	// The tmux-ui registry is exposed via a documented FeatureDeps key when the
	// tmux-ui feature is active. Read it defensively — it's optional.
	const tmuxRegistry = (deps['tmuxSessionRegistry'] as TmuxSessionRegistry | undefined) ?? undefined;

	const actions = new DesktopAssistantActions({
		connectionService: service,
		surfaceRegistry,
		tmuxRegistry,
	});

	const askCommand = vscode.commands.registerCommand('pocketshell.assistant.ask', async () => {
		await runAskCommand(ctx, actions);
	});
	const configureCommand = vscode.commands.registerCommand('pocketshell.assistant.configure', async () => {
		await runConfigureCommand(ctx);
	});

	// Capture the terminal tracker so it's disposed with the feature.
	const trackerDisposable = new DisposableLike(() => actions.activeSessionResolver.dispose());

	return [askCommand, configureCommand, trackerDisposable];
}

/** Run the ask command: prompt for a transcript, run the loop, surface the outcome. */
async function runAskCommand(ctx: vscode.ExtensionContext, actions: DesktopAssistantActions): Promise<void> {
	const transcript = await vscode.window.showInputBox({
		prompt: 'What would you like the assistant to do?',
		placeHolder: 'e.g. What hosts am I connected to? What sessions are running on prod?',
		ignoreFocusOut: true,
	});
	if (!transcript || transcript.trim().length === 0) {
		return;
	}

	const client = await buildClient(ctx);
	if (!client) {
		// buildClient already surfaced an error + the configure prompt.
		return;
	}

	const confirmGate: ConfirmGate = desktopConfirmGate;
	const choiceGate: ChoiceGate = desktopChoiceGate;
	const loop = new AssistantAgentLoop({ client, actions, sessionId: null });

	const outcome = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'PocketShell assistant', cancellable: false },
		async () => loop.run(transcript, { confirmGate, choiceGate }),
	);

	surfaceOutcome(outcome);
}

/** Configure command: open settings, then prompt for the API key if missing. */
async function runConfigureCommand(ctx: vscode.ExtensionContext): Promise<void> {
	const choice = await vscode.window.showQuickPick(
		[
			{ label: 'Set OpenAI API key', provider: 'openai' as const },
			{ label: 'Open settings', provider: undefined },
		],
		{ placeHolder: 'Configure the assistant provider' },
	);
	if (!choice) return;
	if (choice.provider === 'openai') {
		const key = await vscode.window.showInputBox({
			prompt: 'OpenAI API key (stored in the OS keychain via SecretStorage)',
			password: true,
			ignoreFocusOut: true,
			placeHolder: 'sk-...',
		});
		if (key && key.trim().length > 0) {
			await saveApiKey(ctx, 'openai', key.trim());
			vscode.window.showInformationMessage('PocketShell assistant: OpenAI API key saved.');
		}
		return;
	}
	await vscode.commands.executeCommand('workbench.action.openSettings', 'pocketshell.assistant');
}

/**
 * Build the LLM client for the active provider, or null if no key is stored
 * (after surfacing an error + offering to configure). Dispatch 1 ships OpenAI
 * only; Anthropic/ZAI arrive in Dispatch 3.
 */
async function buildClient(ctx: vscode.ExtensionContext): Promise<AssistantLlmClient | null> {
	const settings = loadAssistantSettings();
	const config = await loadProviderConfig(ctx, settings);
	if (!config) {
		const configure = await vscode.window.showErrorMessage(
			`No API key stored for the ${settings.provider} assistant provider. Set one to use the assistant.`,
			'Configure',
		);
		if (configure === 'Configure') {
			await runConfigureCommand(ctx);
		}
		return null;
	}
	if (settings.provider === 'openai') {
		return new OpenAiLlmClient(config);
	}
	vscode.window.showWarningMessage(
		`The ${settings.provider} provider is supported in a follow-up update. Dispatch 1 ships OpenAI only.`,
	);
	return null;
}

/** Surface the loop's Outcome as an VS Code notification. */
function surfaceOutcome(outcome: Outcome): void {
	switch (outcome.kind) {
		case 'answer':
			vscode.window.showInformationMessage(outcome.text);
			break;
		case 'cancelled':
			vscode.window.showInformationMessage(outcome.text);
			break;
		case 'failed':
			vscode.window.showErrorMessage(`Assistant failed: ${outcome.message}`);
			break;
		case 'retryable_error':
			vscode.window.showWarningMessage(`Assistant: ${outcome.message}`);
			break;
	}
}

/**
 * The confirm-or-correct UX seam (orchestrator decision #5). Mutating candidate
 * -> showQuickPick([Approve, Edit...]); Edit -> showInputBox (empty/dismiss =
 * Cancel). No `kind` discriminator (lesson #13).
 */
const desktopConfirmGate: ConfirmGate = async (candidate: Candidate): Promise<Decision> => {
	const title = candidate.summary || candidate.toolName;
	const pick = await vscode.window.showQuickPick(
		[
			{ label: 'Approve', value: 'confirm' as const },
			{ label: 'Edit...', value: 'edit' as const },
			{ label: 'Cancel', value: 'cancel' as const },
		],
		{ placeHolder: `Assistant wants to: ${title}`, ignoreFocusOut: true },
	);
	if (!pick) return { kind: 'cancel' };
	if (pick.value === 'confirm') return { kind: 'confirm' };
	if (pick.value === 'cancel') return { kind: 'cancel' };
	// Edit.
	const correction = await vscode.window.showInputBox({
		prompt: 'Correct the proposed action (empty = cancel)',
		value: title,
		ignoreFocusOut: true,
	});
	if (!correction || correction.trim().length === 0) {
		return { kind: 'cancel' };
	}
	return { kind: 'correct', correction: correction.trim() };
};

/**
 * The folder-disambiguation UX seam (used when resolve_folder lands in the
 * Ambiguous band). No `kind` discriminator (lesson #13).
 */
const desktopChoiceGate: ChoiceGate = async (_query, candidates): Promise<ChoiceDecision> => {
	type ChoiceItem = { label: string; candidate: FolderCandidate | undefined };
	const items: ChoiceItem[] = candidates.map((c) => ({ label: `${c.label} (${c.path})`, candidate: c }));
	items.push({ label: 'Cancel', candidate: undefined });
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: 'Which folder did you mean?',
		ignoreFocusOut: true,
	});
	if (!pick || !pick.candidate) return { kind: 'cancel' };
	return { kind: 'pick', candidate: pick.candidate };
};

/**
 * Minimal vscode.Disposable shim so we can wrap the resolver's dispose() into a
 * Disposable[] element without exposing the class. (Avoids importing vscode's
 * Disposable type into the dispose signature twice.)
 */
class DisposableLike implements vscode.Disposable {
	constructor(private readonly fn: () => void) {}
	dispose(): void {
		this.fn();
	}
}
