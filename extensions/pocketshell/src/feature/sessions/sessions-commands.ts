import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId } from '../../host-picking';
import { AgentDetector } from '../../backend/agents/agent-detector';
import { AgentType, AGENT_METADATA } from '../../backend/agents/types';
import type { DetectedAgent } from '../../backend/agents/types';
import {
	buildDirectorySuggestions,
	buildRemoteDirectorySuggestionCommand,
	type DirectorySuggestion,
	type SessionKind,
} from '../../backend/sessions/create-session';
import type { SshConnection } from '../../backend/ssh/connection/ssh-client';
import type { FeatureDeps } from '../manifest';
import { launchTmuxSession, resolveLaunchConnection } from './session-launcher';

interface SessionCommandTarget {
	hostId?: number;
	folderId?: number;
	path?: string;
}

interface SessionKindPick extends vscode.QuickPickItem {
	sessionKind: SessionKind;
}

interface StartDirectoryPick extends vscode.QuickPickItem {
	manual: boolean;
	path: string;
}

export function registerSessions(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const create = async (element?: unknown): Promise<void> => {
		await createSession(service, element);
	};
	return [
		vscode.commands.registerCommand('pocketshell.sessions.create', create),
		vscode.commands.registerCommand('pocketshell.session.create', create),
	];
}

async function createSession(service: ConnectionService, element: unknown): Promise<void> {
	const target = resolveSessionTarget(element);
	const hostId = await resolveHostId(service, target?.hostId ?? element, { connectedOnly: false });
	if (hostId === undefined) {
		return;
	}

	const resolved = await resolveLaunchConnection(service, hostId);
	if (!resolved) {
		return;
	}
	const { conn, host } = resolved;

	const watchedFolders = await service.getWatchedFolders(hostId);
	const [kind, remoteOutput] = await Promise.all([
		pickSessionKind(conn),
		loadRemoteDirectoryOutput(conn, target?.path),
	]);
	if (!kind) {
		return;
	}

	const startDirectory = await pickStartDirectory(
		buildDirectorySuggestions(watchedFolders, remoteOutput),
		target?.path,
	);
	if (startDirectory === undefined) {
		return;
	}

	// Delegate the tmux setup + terminal creation to the shared launcher so the
	// assistant's start_session tool launches through the exact same path.
	const launched = await launchTmuxSession(conn, host, startDirectory, kind);
	if (!launched.ok) {
		return;
	}

	await vscode.commands.executeCommand('pocketshell.hostDetail.open', hostId);
}

async function pickSessionKind(conn: SshConnection): Promise<SessionKind | undefined> {
	const installedAgents = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t('Detecting installed agents...'),
			cancellable: false,
		},
		async () => {
			try {
				return await new AgentDetector(conn).detectAll();
			} catch {
				return [];
			}
		},
	);

	const agentItems: SessionKindPick[] = installedAgents
		.filter((agent: DetectedAgent) => agent.isInstalled && agent.type !== AgentType.Unknown)
		.map((agent: DetectedAgent) => ({
			label: AGENT_METADATA[agent.type as Exclude<AgentType, AgentType.Unknown>].name,
			description: agent.version,
			detail: agent.binaryPath,
			sessionKind: agent.type as Exclude<SessionKind, 'shell'>,
		}));

	const picked = await vscode.window.showQuickPick<SessionKindPick>([
		{ label: vscode.l10n.t('Shell'), description: vscode.l10n.t('Start an interactive shell'), sessionKind: 'shell' },
		...agentItems,
	], {
		placeHolder: vscode.l10n.t('Choose session type'),
	});
	return picked?.sessionKind;
}

async function pickStartDirectory(
	suggestions: DirectorySuggestion[],
	initialPath?: string,
): Promise<string | undefined> {
	const manual: StartDirectoryPick = {
		label: vscode.l10n.t('Enter Manually'),
		description: vscode.l10n.t('Type a remote start directory'),
		path: initialPath ?? '',
		manual: true,
	};
	const effectiveSuggestions = initialPath && !suggestions.some((suggestion) => suggestion.path === initialPath)
		? [{ label: initialPath, path: initialPath, source: 'remote' as const }, ...suggestions]
		: suggestions;
	const items: StartDirectoryPick[] = effectiveSuggestions.map((suggestion) => ({
		label: suggestion.label,
		description: suggestion.path,
		detail: suggestion.source === 'watched' ? vscode.l10n.t('Watched folder') : vscode.l10n.t('Remote directory'),
		path: suggestion.path,
		manual: false,
	}));
	const picked = await vscode.window.showQuickPick<StartDirectoryPick>([...items, manual], {
		placeHolder: vscode.l10n.t('Choose a start directory'),
	});
	if (!picked) {
		return undefined;
	}

	return vscode.window.showInputBox({
		prompt: vscode.l10n.t('Start directory'),
		value: picked.manual ? (initialPath ?? '') : picked.path,
		placeHolder: '/home/user/project',
		validateInput: (value: string) => value.trim() ? undefined : vscode.l10n.t('Start directory is required'),
	});
}

async function loadRemoteDirectoryOutput(conn: SshConnection, seedPath?: string): Promise<string> {
	try {
		const result = await conn.exec(buildRemoteDirectorySuggestionCommand(seedPath), 3_000);
		return result.exitCode === 0 ? result.stdout : '';
	} catch {
		return '';
	}
}

function resolveSessionTarget(element: unknown): SessionCommandTarget | undefined {
	if (!element || typeof element !== 'object') {
		return undefined;
	}
	const value = element as Record<string, unknown>;
	return {
		hostId: typeof value.hostId === 'number' ? value.hostId : undefined,
		folderId: typeof value.folderId === 'number' ? value.folderId : undefined,
		path: typeof value.path === 'string' ? value.path : undefined,
	};
}
