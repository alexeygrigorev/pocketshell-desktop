/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import type { SessionTerminalRegistry } from '../surface/session-terminal-registry';
import type { TmuxSessionRegistry } from '../tmux-ui/tmux-session-registry';
import type { SshConnection } from '../../backend/ssh/connection/ssh-client';
import type { PocketShellRepos } from '../../backend/git/pocketshell-repos';
import type { WatchedFolder } from '../../backend/ssh/data/watched-folder-store';
import type {
	AssistantActions,
	FolderCandidate,
	FolderResolutionResult,
} from '../../backend/assistant/assistant-actions';
import { ActionResult } from '../../backend/assistant/assistant-actions';
import { resolveFolder } from '../../backend/assistant/folder-resolver';
import type { FolderResolution } from '../../backend/assistant/folder-resolver';
import {
	buildCloneTarget,
	buildCreatedPath,
	buildCreateFileHeredoc,
	buildMkdirCommand,
	hasPathTraversal,
	isSafeFolderName,
	mapAgentNameToSessionKind,
} from '../../backend/assistant/mutating-helpers';
import type { SessionKind } from '../../backend/sessions/create-session';
import { launchTmuxSessionForAssistant, resolveLaunchConnection } from '../sessions/session-launcher';
import type { TmuxSessionPseudoterminal } from '../tmux-ui/tmux-session-terminal';
import { ActiveSessionResolver, type ActiveSession } from './active-session-resolver';

/**
 * Production AssistantActions backed by the live desktop surfaces (terminal
 * registries, ConnectionService, SSH exec, git repos, watched folders).
 *
 * This is the desktop analog of the app's `AppAssistantActions` — the seam
 * implementation the agent loop calls. It is the ONLY place the loop touches
 * vscode / SSH / tmux. Lives in the feature layer (NOT mirrored): it depends
 * on vscode + the live registries + the connection service.
 *
 * Dispatch 1: the 11 inspect / navigation methods + the loop/gate/catalog.
 * Dispatch 2: the 6 mutating methods are IMPLEMENTED behind the confirm gate
 * (start_session, send_prompt_to_session, create_project, run_command,
 * create_file, clone_repo). The gate is now LIVE — an approved mutating call
 * flows model → CommandSafety (run_command) → confirm gate → real execution.
 */

/** Default clone root when the deps don't supply one (matches the app's ~/git). */
const DEFAULT_CLONE_ROOT = '~/git';

/** Max bytes read by read_file (matches the app's `head -c 8192`). */
const READ_FILE_BYTE_LIMIT = 8192;

export interface DesktopAssistantActionsDeps {
	readonly connectionService: ConnectionService;
	readonly surfaceRegistry?: SessionTerminalRegistry;
	readonly tmuxRegistry?: TmuxSessionRegistry;
	/** Resolve the SFTP root / default clone root for the active host (optional). */
	readonly getDefaultCloneRoot?: (hostId: number) => Promise<string | undefined>;
}

export class DesktopAssistantActions implements AssistantActions {
	private readonly resolver: ActiveSessionResolver;

	constructor(private readonly deps: DesktopAssistantActionsDeps) {
		this.resolver = new ActiveSessionResolver(deps.connectionService, deps.surfaceRegistry, deps.tmuxRegistry);
	}

	/** Exposed for the commands layer to dispose the terminal tracker. */
	get activeSessionResolver(): ActiveSessionResolver {
		return this.resolver;
	}

	// ---- Inspect (auto-run, read-only) ----------------------------------

	async getContext(): Promise<string> {
		const session = await this.resolver.resolveActive();
		if (!session) {
			return JSON.stringify({ connected: false, note: 'No PocketShell terminal open and no host connected. Open a session first.' });
		}
		const cwd = await this.activeCwd(session);
		const lines: string[] = [];
		lines.push(`host: ${session.hostLabel}`);
		lines.push(`host_id: ${session.hostId}`);
		lines.push(`connected: true`);
		lines.push(`session: ${session.sessionName ?? '<none>'}`);
		lines.push(`cwd: ${cwd ?? '<unknown>'}`);
		return lines.join('\n');
	}

	async listHosts(): Promise<string> {
		const hosts = await this.resolver.listHosts();
		if (hosts.length === 0) {
			return 'No saved hosts.';
		}
		const lines: string[] = [];
		for (const host of hosts) {
			const conn = this.deps.connectionService.getConnection(host.id);
			const connected = !!conn && conn.connected;
			lines.push(`- ${host.name} (id=${host.id})${connected ? ' [connected]' : ''}`);
		}
		return lines.join('\n');
	}

	async listFolders(host: string): Promise<string> {
		const hostId = await this.resolveHostId(host);
		if (hostId === undefined) {
			return `Unknown host: ${host}`;
		}
		const candidates = await this.folderCandidates(hostId);
		if (candidates.length === 0) {
			return `No known folders on ${host}.`;
		}
		return candidates.map((c) => `- ${c.label} (${c.path})${c.sessionCount ? ` [${c.sessionCount} session(s)]` : ''}`).join('\n');
	}

	async resolveFolder(host: string, query: string): Promise<FolderResolutionResult> {
		const hostId = await this.resolveHostId(host);
		if (hostId === undefined) {
			return { kind: 'unavailable', message: `Unknown host: ${host}` };
		}
		const candidates = await this.folderCandidates(hostId);
		if (candidates.length === 0) {
			return { kind: 'unavailable', message: `No known folders on ${host}.` };
		}
		const resolution = resolveFolder(query, candidates);
		return { kind: 'resolved', resolution };
	}

	async listSessions(host: string): Promise<string> {
		const hostId = await this.resolveHostId(host);
		if (hostId === undefined) {
			return `Unknown host: ${host}`;
		}
		const conn = this.deps.connectionService.getConnection(hostId);
		if (!conn || !conn.connected) {
			return `Host ${host} is not connected.`;
		}
		try {
			const result = await conn.exec('tmux list-sessions -F "#{session_name}: #{session_path}"', 5000);
			if (result.exitCode !== 0) {
				return `No tmux sessions on ${host} (or tmux not installed).`;
			}
			return result.stdout.trim() || `No tmux sessions on ${host}.`;
		} catch (err) {
			return `Failed to list sessions on ${host}: ${errorMessage(err)}`;
		}
	}

	async listDirectory(path: string): Promise<string> {
		const conn = await this.requireActiveConnection();
		if (typeof conn !== 'object') return conn;
		try {
			const expanded = expandTilde(path);
			const result = await conn.exec(`ls -la ${shellQuote(expanded)}`, 10_000);
			if (result.exitCode !== 0) {
				return `Failed to list ${path}: ${(result.stderr || '').trim() || 'exit ' + result.exitCode}`;
			}
			return result.stdout.trim();
		} catch (err) {
			return `Failed to list ${path}: ${errorMessage(err)}`;
		}
	}

	async readFile(path: string): Promise<string> {
		const conn = await this.requireActiveConnection();
		if (typeof conn !== 'object') return conn;
		try {
			const expanded = expandTilde(path);
			const result = await conn.exec(`head -c ${READ_FILE_BYTE_LIMIT} ${shellQuote(expanded)}`, 10_000);
			if (result.exitCode !== 0) {
				return `Failed to read ${path}: ${(result.stderr || '').trim() || 'exit ' + result.exitCode}`;
			}
			return result.stdout;
		} catch (err) {
			return `Failed to read ${path}: ${errorMessage(err)}`;
		}
	}

	async listRepos(): Promise<string> {
		const conn = await this.requireActiveConnection();
		if (typeof conn !== 'object') return conn;
		const repos = await this.listRemoteRepos(conn);
		if (typeof repos === 'string') return repos;
		if (repos.length === 0) {
			return 'No GitHub repositories found (or `gh` is not authenticated on this host).';
		}
		return repos.map((r) => `- ${r}`).join('\n');
	}

	// ---- Act — navigation (auto) ----------------------------------------

	async openFolder(host: string, path: string): Promise<string> {
		const hostId = await this.resolveHostId(host);
		if (hostId === undefined) {
			return `Unknown host: ${host}`;
		}
		// Reveal the folder in the SFTP explorer if possible. We don't fail if
		// the SFTP view is closed — navigation is best-effort in D1.
		try {
			const uri = vscode.Uri.parse(`pocketshell-sftp:/${host}${path}`);
			await vscode.commands.executeCommand('revealInExplorer', uri);
		} catch {
			// Best-effort: many real environments don't have a reveal target.
		}
		return `Focused folder ${path} on ${host}.`;
	}

	async openSession(sessionName: string): Promise<string> {
		// Find the session in either registry and focus its terminal.
		if (this.deps.surfaceRegistry) {
			for (const entry of this.deps.surfaceRegistry.list()) {
				if (entry.sessionName === sessionName) {
					entry.terminal.show(true);
					return `Focused session ${sessionName}.`;
				}
			}
		}
		if (this.deps.tmuxRegistry) {
			for (const entry of this.deps.tmuxRegistry.entries()) {
				if (entry.sessionName === sessionName) {
					entry.terminal.show(true);
					return `Focused session ${sessionName}.`;
				}
			}
		}
		return `No open session named ${sessionName}. Use list_sessions to see what's available.`;
	}

	async openScreen(destination: string): Promise<string> {
		const allowed: Record<string, string> = {
			hosts: 'pocketshell.focusHosts',
			settings: 'pocketshell.settings.open',
			usage: 'pocketshell.usage.openPanel',
			ai_costs: 'pocketshell.usage.openPanel',
			crash_reports: 'pocketshell.diagnostics.showReport',
		};
		const command = allowed[destination];
		if (!command) {
			return `Unknown screen: ${destination}. Allowed: ${Object.keys(allowed).join(', ')}.`;
		}
		try {
			await vscode.commands.executeCommand(command);
			return `Opened ${destination}.`;
		} catch {
			return `Could not open ${destination} on this installation.`;
		}
	}

	// ---- Act — mutating (confirm-gated; Dispatch 2) ---------------------

	async startSession(host: string, cwd: string, agent: string): Promise<ActionResult> {
		const mapped = mapAgentNameToSessionKind(agent);
		if (mapped === null) {
			return ActionResult.error(`Unknown agent: ${agent}. Allowed: claude, codex, opencode, shell.`);
		}
		if (!cwd || cwd.trim().length === 0) {
			return ActionResult.error('A working directory (cwd) is required to start a session.');
		}
		// The assistant drives the session it starts via the surface registry
		// (send_prompt_to_session / run_command resolve ptys from it). Without a
		// registry the round-trip can't work, so fail fast with a clear message
		// instead of launching an undrivable session.
		if (!this.deps.surfaceRegistry) {
			return ActionResult.error('The session terminal surface is unavailable on this installation.');
		}
		const hostId = await this.resolveHostId(host);
		if (hostId === undefined) {
			return ActionResult.error(`Unknown host: ${host}`);
		}
		// Resolve host → connection (connecting if necessary), mirroring createSession.
		const resolved = await resolveLaunchConnection(this.deps.connectionService, hostId);
		if (!resolved) {
			return ActionResult.error(`Could not connect to ${host}.`);
		}
		// Cast the validated agent name to the launcher's SessionKind (structurally
		// identical: the non-shell members are the AgentType string values).
		const kind = mapped as SessionKind;
		// Launch through the ASSISTANT-SPECIFIC path: same tmux setup + agent-command
		// send as createSession, but attaches via a registered TmuxSessionPseudoterminal
		// so the assistant's own tools can drive it (D2.5 parity fix).
		const launched = await launchTmuxSessionForAssistant(
			resolved.conn,
			resolved.host,
			cwd,
			kind,
			this.deps.surfaceRegistry,
		);
		if (!launched.ok) {
			return ActionResult.error(launched.message);
		}
		return ActionResult.ok(`Started ${agent} session "${launched.result.sessionName}" in ${cwd} on ${host}.`);
	}

	async sendPromptToSession(sessionName: string, prompt: string): Promise<ActionResult> {
		if (!sessionName || sessionName.trim().length === 0) {
			return ActionResult.error('Missing target session.');
		}
		if (!prompt || prompt.trim().length === 0) {
			return ActionResult.error('Missing prompt.');
		}
		// Find the named session's pane in either registry (like openSession),
		// then send the prompt to its active pane INTERACTIVELY (matching the
		// app's sendPromptToSession: visible in the live pane, submit:true).
		const target = this.findSessionPty(sessionName);
		if (!target) {
			return ActionResult.error(
				`No open session named ${sessionName}. Use start_session to launch it first.`,
			);
		}
		try {
			// submit=true appends Enter so the prompt runs (interactive, visible).
			await target.pty.sendTextToActivePane(prompt, true);
			return ActionResult.ok(`Sent prompt to session ${sessionName}.`);
		} catch (err) {
			return ActionResult.error(
				`Failed to send prompt to session ${sessionName}: ${errorMessage(err)}`,
			);
		}
	}

	async createProject(host: string, parentPath: string, folderName: string): Promise<ActionResult> {
		// Validate model-controlled inputs BEFORE any shell construction.
		if (hasPathTraversal(parentPath)) {
			return ActionResult.error(`Refusing to create a project: parent path "${parentPath}" contains a ".." segment.`);
		}
		if (!isSafeFolderName(folderName)) {
			return ActionResult.error(
				`Invalid folder name "${folderName}". Use a single path component (no slashes, no "..").`,
			);
		}
		const conn = await this.resolveHostConnection(host);
		if (isActionResult(conn)) return conn;
		const command = buildMkdirCommand(parentPath, folderName);
		try {
			const result = await conn.exec(command, 10_000);
			if (result.exitCode !== 0) {
				return ActionResult.error(
					`Failed to create project: ${(result.stderr || '').trim() || 'exit ' + result.exitCode}`,
				);
			}
			return ActionResult.ok(`Created project ${buildCreatedPath(parentPath, folderName)}.`);
		} catch (err) {
			return ActionResult.error(`Failed to create project: ${errorMessage(err)}`);
		}
	}

	async runCommand(command: string): Promise<ActionResult> {
		// Safety already validated by the loop (CommandSafety) before this call,
		// AND the user confirmed the exact command at the gate. Send it to the
		// ACTIVE session's pane INTERACTIVELY (matching the app's
		// SessionActionBridge.sendCommand: visible in the live pane, submit:true).
		const session = await this.resolver.resolveActive();
		if (!session || !session.pty) {
			return ActionResult.error('No active terminal to run the command in. Use start_session first.');
		}
		try {
			await session.pty.sendTextToActivePane(command, true);
			return ActionResult.ok(`Ran: ${command}`);
		} catch (err) {
			return ActionResult.error(
				`Failed to send command to the active terminal: ${errorMessage(err)}`,
			);
		}
	}

	async createFile(path: string, content: string): Promise<ActionResult> {
		// Reject path traversal in the target path (model-controlled).
		if (hasPathTraversal(path)) {
			return ActionResult.error(`Refusing to create file: path "${path}" contains a ".." segment.`);
		}
		const conn = await this.requireActiveConnection();
		if (typeof conn !== 'object') return ActionResult.error(conn);
		// Prefer SFTP write so file CONTENT is never shell-interpreted (content
		// may contain quotes / $ / backticks / newlines — a heredoc risks
		// delimiter collision + expansion). Fall back to a collision-guarded
		// quoted-delimiter heredoc if SFTP is unreachable per-session.
		const sftpWritten = await this.tryWriteFileViaSftp(conn, path, content);
		if (sftpWritten === true) {
			return ActionResult.ok(`Created ${path}.`);
		}
		if (typeof sftpWritten === 'string') {
			// SFTP reported a structured error — surface it (no heredoc fallback).
			return ActionResult.error(`Failed to create ${path}: ${sftpWritten}`);
		}
		// SFTP unavailable — fall back to the collision-guarded heredoc.
		const heredoc = buildCreateFileHeredoc(path, content);
		if (!heredoc.ok) {
			return ActionResult.error(`Failed to create ${path}: ${heredoc.error}`);
		}
		try {
			const result = await conn.exec(heredoc.command, 10_000);
			if (result.exitCode !== 0) {
				return ActionResult.error(
					`Failed to create ${path}: ${(result.stderr || '').trim() || 'exit ' + result.exitCode}`,
				);
			}
			return ActionResult.ok(`Created ${path}.`);
		} catch (err) {
			return ActionResult.error(`Failed to create ${path}: ${errorMessage(err)}`);
		}
	}

	async cloneRepo(fullName: string, folder: string | null): Promise<ActionResult> {
		if (!fullName || fullName.trim().length === 0) {
			return ActionResult.error('Missing repository full name (owner/repo).');
		}
		if (hasPathTraversal(fullName)) {
			return ActionResult.error(`Refusing to clone: "${fullName}" contains a ".." segment.`);
		}
		const conn = await this.requireActiveConnection();
		if (typeof conn !== 'object') return ActionResult.error(conn);
		// Resolve the clone root: deps.getDefaultCloneRoot if available, else the
		// app-default ~/git. The target path is built from model-controlled
		// input, so it is shell-quoted in the command below.
		const defaultRoot = await this.resolveDefaultCloneRoot(conn);
		const target = buildCloneTarget(fullName, folder, defaultRoot);
		// Prefer the server-side pocketshell repos CLI (no client credentials).
		try {
			const { PocketShellRepos } = await import('../../backend/git/pocketshell-repos');
			const repos = new PocketShellRepos(conn);
			const clonedPath = await repos.clone(fullName, target);
			return ActionResult.ok(`Cloned ${fullName} to ${clonedPath}.`);
		} catch (err) {
			// If the server-side CLI is unavailable (exit 127) or GitHub is not
			// authenticated, surface a clear error rather than silently falling
			// back to a client-side clone (which would need credentials).
			const message = errorMessage(err);
			if (isPocketshellReposUnavailable(message)) {
				return ActionResult.error(
					`pocketshell repos is not installed on the host. ` +
						`Install it, or clone manually via the terminal.`,
				);
			}
			return ActionResult.error(`Failed to clone ${fullName}: ${message}`);
		}
	}

	// ---- helpers --------------------------------------------------------

	/**
	 * Resolve a host name (or numeric id string) to a stable host id.
	 * Matches by name first, then by stringified id.
	 */
	private async resolveHostId(host: string): Promise<number | undefined> {
		const hosts = await this.resolver.listHosts();
		const byName = hosts.find((h) => h.name === host);
		if (byName) return byName.id;
		const asNum = Number.parseInt(host, 10);
		if (Number.isFinite(asNum)) {
			const byId = hosts.find((h) => h.id === asNum);
			if (byId) return byId.id;
		}
		return undefined;
	}

	/**
	 * Build the FULL folder candidate set for `hostId`: watched folders +
	 * live tmux session cwds. Drawn from real data only — never synthesised.
	 */
	private async folderCandidates(hostId: number): Promise<FolderCandidate[]> {
		const map = new Map<string, FolderCandidate>();
		// Watched folders (labels from the store).
		try {
			const watched = await this.deps.connectionService.getWatchedFolders(hostId);
			for (const wf of watched) {
				if (!wf.enabled) continue;
				this.mergeCandidate(map, wf.path, wf.label || pathTail(wf.path), 0);
			}
		} catch {
			// Best-effort: watched-folder store may be unavailable.
		}
		// Live tmux session cwds (grouped — sessionCount per cwd).
		const conn = this.deps.connectionService.getConnection(hostId);
		if (conn && conn.connected) {
			try {
				const result = await conn.exec('tmux list-sessions -F "#{session_name}\t#{session_path}"', 5000);
				if (result.exitCode === 0) {
					const cwdCounts = new Map<string, { count: number; name: string }>();
					for (const line of result.stdout.split('\n')) {
						const trimmed = line.trim();
						if (!trimmed) continue;
						const [name, cwd] = trimmed.split('\t');
						if (!cwd) continue;
						const existing = cwdCounts.get(cwd);
						if (existing) {
							existing.count++;
						} else {
							cwdCounts.set(cwd, { count: 1, name: name ?? '' });
						}
					}
					for (const [cwd, info] of cwdCounts) {
						this.mergeCandidate(map, cwd, pathTail(cwd), info.count);
					}
				}
			} catch {
				// Best-effort: tmux may be absent.
			}
		}
		return [...map.values()];
	}

	private mergeCandidate(map: Map<string, FolderCandidate>, path: string, label: string, sessionCount: number): void {
		const existing = map.get(path);
		if (existing) {
			// Prefer a non-empty label; sum session counts.
			const mergedLabel = existing.label || label;
			map.set(path, { path, label: mergedLabel, sessionCount: (existing.sessionCount ?? 0) + sessionCount });
		} else {
			map.set(path, { path, label, sessionCount });
		}
	}

	/** Resolve the cwd of the active pane if a pty is available. */
	private async activeCwd(session: ActiveSession): Promise<string | null> {
		if (!session.pty) return null;
		try {
			const meta = session.pty.getActivePaneMetadata();
			return meta?.cwd ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Require an active SSH connection for the exec-backed inspect tools.
	 * Returns the connection or an error string (so the tool result degrades
	 * gracefully instead of throwing).
	 */
	private async requireActiveConnection(): Promise<SshConnection | string> {
		const host = await this.resolver.firstConnectedHost();
		if (!host) {
			return 'No host is connected. Connect to a host first, then retry.';
		}
		const conn = this.deps.connectionService.getConnection(host.id);
		if (!conn || !conn.connected) {
			return `Host ${host.name} is not connected.`;
		}
		return conn;
	}

	/** List remote GitHub repos, returning just the full-name strings. */
	private async listRemoteRepos(conn: SshConnection): Promise<string[] | string> {
		try {
			// Use the PocketShellRepos adapter for parity with the browse command.
			const { PocketShellRepos } = await import('../../backend/git/pocketshell-repos');
			const repos = new PocketShellRepos(conn);
			const entries = await repos.listRemote({ limit: 50 });
			return entries.map((e) => e.fullName).filter((n): n is string => typeof n === 'string');
		} catch (err) {
			return `Failed to list repos: ${errorMessage(err)}`;
		}
	}

	/**
	 * Resolve a host name/id to a live SSH connection (requireActiveConnection
	 * variant that reports the host name in the error). Returns the connection
	 * or an error string. Used by create_project / clone (host-targeted tools).
	 */
	private async resolveHostConnection(host: string): Promise<SshConnection | ActionResult> {
		const hostId = await this.resolveHostId(host);
		if (hostId === undefined) {
			return ActionResult.error(`Unknown host: ${host}`);
		}
		const conn = this.deps.connectionService.getConnection(hostId);
		if (!conn || !conn.connected) {
			return ActionResult.error(`Host ${host} is not connected.`);
		}
		return conn;
	}

	/**
	 * Find the pty for a named session in either registry (surface then tmux-ui),
	 * mirroring how openSession resolves a session. Returns null when no open
	 * session matches (the action tells the model to start_session first).
	 */
	private findSessionPty(sessionName: string): { pty: TmuxSessionPseudoterminal } | null {
		if (this.deps.surfaceRegistry) {
			for (const entry of this.deps.surfaceRegistry.list()) {
				if (entry.sessionName === sessionName) {
					const pty = this.deps.surfaceRegistry.getPty(entry.hostId, entry.sessionName);
					if (pty) return { pty };
				}
			}
		}
		if (this.deps.tmuxRegistry) {
			for (const entry of this.deps.tmuxRegistry.entries()) {
				if (entry.sessionName === sessionName) {
					return { pty: entry.pty };
				}
			}
		}
		return null;
	}

	/**
	 * Try writing a file via SFTP (the clean path — content is never shell-
	 * interpreted). Returns true on success, a string error message on a
	 * structured SFTP failure, or false when SFTP is unavailable (so the caller
	 * falls back to the heredoc). Always tears down the SFTP session.
	 */
	private async tryWriteFileViaSftp(
		conn: SshConnection,
		path: string,
		content: string,
	): Promise<boolean | string> {
		const { SftpClient } = await import('../../backend/files/sftp-client');
		const sftp = new SftpClient(conn);
		try {
			await sftp.connect();
		} catch {
			// SFTP subsystem unavailable (e.g. not enabled on the remote). Signal
			// the caller to fall back to the heredoc.
			return false;
		}
		try {
			await sftp.writeFile(path, content);
			return true;
		} catch (err) {
			return errorMessage(err);
		} finally {
			sftp.disconnect();
		}
	}

	/**
	 * Resolve the default clone root for the active connection's host. Uses
	 * deps.getDefaultCloneRoot when wired; otherwise the app-default ~/git.
	 */
	private async resolveDefaultCloneRoot(conn: SshConnection): Promise<string> {
		if (this.deps.getDefaultCloneRoot) {
			const hostId = await this.connectionHostId(conn);
			if (hostId !== undefined) {
				const root = await this.deps.getDefaultCloneRoot(hostId);
				if (root) return root;
			}
		}
		return DEFAULT_CLONE_ROOT;
	}

	/** Best-effort reverse-lookup of a connection's host id (for clone-root). */
	private async connectionHostId(_conn: SshConnection): Promise<number | undefined> {
		const host = await this.resolver.firstConnectedHost();
		return host?.id;
	}
}

/**
 * Whether an error message indicates the server-side `pocketshell repos` CLI is
 * not installed / not on PATH (PocketShellRepos.clone formats this case as a
 * clean "not installed or not on PATH" error). Used to give the model a clear,
 * actionable error instead of the raw stderr.
 */
function isPocketshellReposUnavailable(message: string): boolean {
	const lower = message.toLowerCase();
	return lower.includes('not installed') || lower.includes('not on path');
}

// ---- pure helpers (kept module-local; not exported as part of the surface) ----

function expandTilde(p: string): string {
	if (p.startsWith('~/')) return '$HOME/' + p.slice(2);
	if (p === '~') return '$HOME';
	return p;
}

function shellQuote(value: string): string {
	// Single-quote, escaping embedded single-quotes. Safe for the read-only
	// ls/head/list-sessions commands we run; mutating commands go through the
	// confirm gate (D2) and are NOT auto-run.
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

function pathTail(p: string): string {
	const clean = p.replace(/\/+$/, '');
	const idx = clean.lastIndexOf('/');
	return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Type guard: whether a resolveHostConnection result is an ActionResult (error). */
function isActionResult(value: SshConnection | ActionResult): value is ActionResult {
	return typeof value === 'object' && value !== null && 'ok' in value && 'message' in value;
}

/** Re-export for type-only consumers in the feature layer. */
export type { FolderResolution, WatchedFolder, PocketShellRepos };
