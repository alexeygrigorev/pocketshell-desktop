import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { getOrConnect, resolveHostId } from '../../host-picking';
import { SshPseudoterminal } from '../../ssh-terminal';
import { AgentDetector } from '../../backend/agents/agent-detector';
import { AgentType, AGENT_METADATA } from '../../backend/agents/types';
import type { DetectedAgent } from '../../backend/agents/types';
import { TmuxClient } from '../../backend/tmux/client';
import { SshShellBridge } from '../../backend/tmux/ssh-shell-bridge';
import type { SshConnection } from '../../backend/ssh/connection/ssh-client';
import {
	buildAgentStartCommand,
	buildDirectorySuggestions,
	buildRemoteDirectorySuggestionCommand,
	buildSessionName,
	buildWindowName,
	quoteShellArg,
	type DirectorySuggestion,
	type SessionKind,
} from '../../backend/sessions/create-session';
import type { FeatureDeps } from '../manifest';

interface SessionCommandTarget {
	hostId?: number;
	folderId?: number;
	path?: string;
}

interface SessionKindPick extends vscode.QuickPickItem {
	kind: SessionKind;
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

	const host = await service.getHost(hostId);
	if (!host) {
		void vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'));
		return;
	}

	const conn = await getOrConnect(service, hostId);
	if (!conn) {
		return;
	}

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

	const sessionName = buildSessionName(startDirectory, kind);
	const windowName = buildWindowName(startDirectory, kind);
	const agentCommand = kind === 'shell' ? undefined : buildAgentStartCommand(kind, startDirectory);
	const tmuxReady = await createOrAttachTmuxSession(conn, sessionName, startDirectory, windowName, agentCommand);
	if (!tmuxReady) {
		return;
	}

	const terminal = vscode.window.createTerminal({
		name: `${host.name || host.hostname}: ${sessionName}`,
		pty: new SshPseudoterminal(conn, host.name || host.hostname, undefined, {
			cwd: startDirectory,
			initialCommand: `tmux attach-session -t ${quoteShellArg(sessionName)}`,
		}),
		iconPath: new vscode.ThemeIcon(kind === 'shell' ? 'terminal-tmux' : 'hubot'),
	});
	terminal.show();

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
			kind: agent.type as Exclude<SessionKind, 'shell'>,
		}));

	const picked = await vscode.window.showQuickPick<SessionKindPick>([
		{ label: vscode.l10n.t('Shell'), description: vscode.l10n.t('Start an interactive shell'), kind: 'shell' },
		...agentItems,
	], {
		placeHolder: vscode.l10n.t('Choose session type'),
	});
	return picked?.kind;
}

async function pickStartDirectory(
	suggestions: DirectorySuggestion[],
	initialPath?: string,
): Promise<string | undefined> {
	const manual: vscode.QuickPickItem & { path?: string; manual?: boolean } = {
		label: vscode.l10n.t('Enter Manually'),
		description: vscode.l10n.t('Type a remote start directory'),
		manual: true,
	};
	const effectiveSuggestions = initialPath && !suggestions.some((suggestion) => suggestion.path === initialPath)
		? [{ label: initialPath, path: initialPath, source: 'remote' as const }, ...suggestions]
		: suggestions;
	const items = effectiveSuggestions.map((suggestion) => ({
		label: suggestion.label,
		description: suggestion.path,
		detail: suggestion.source === 'watched' ? vscode.l10n.t('Watched folder') : vscode.l10n.t('Remote directory'),
		path: suggestion.path,
	}));
	const picked = await vscode.window.showQuickPick([...items, manual], {
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

async function createOrAttachTmuxSession(
	conn: SshConnection,
	sessionName: string,
	startDirectory: string,
	windowName: string,
	agentCommand?: string,
): Promise<boolean> {
	const sessionAlreadyExists = await hasTmuxSession(conn, sessionName);
	const shell = await conn.shell();
	const client = new TmuxClient({
		sessionName,
		startDir: startDirectory || undefined,
		initialCommand: agentCommand && !sessionAlreadyExists ? agentCommand : undefined,
		commandTimeoutMs: 10_000,
	});
	try {
		await client.connect(new SshShellBridge(shell));
		if (agentCommand && sessionAlreadyExists) {
			const window = await client.newWindowWithPaneId(sessionName, windowName, startDirectory || undefined);
			if (window.isError) {
				void vscode.window.showErrorMessage(vscode.l10n.t('tmux new-window failed: {0}', window.output.join('\n')));
				return false;
			}
			const paneId = window.output.find((line) => line.startsWith('%'));
			if (!paneId) {
				void vscode.window.showErrorMessage(vscode.l10n.t('tmux did not report the new pane id.'));
				return false;
			}
			const sent = await client.sendKeysLiteral(paneId, agentCommand);
			if (sent.isError) {
				void vscode.window.showErrorMessage(vscode.l10n.t('tmux send-keys failed: {0}', sent.output.join('\n')));
				return false;
			}
		}
		return true;
	} catch (err) {
		void vscode.window.showErrorMessage(vscode.l10n.t('Failed to create tmux session: {0}', String(err)));
		return false;
	} finally {
		try {
			await client.detach();
		} catch {
			await client.close();
		}
	}
}

async function hasTmuxSession(conn: SshConnection, sessionName: string): Promise<boolean> {
	try {
		const result = await conn.exec(`tmux has-session -t ${quoteShellArg(sessionName)}`, 3_000);
		return result.exitCode === 0;
	} catch {
		return false;
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
