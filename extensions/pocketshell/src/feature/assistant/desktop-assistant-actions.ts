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
 * Dispatch 1: the 11 inspect / navigation methods are IMPLEMENTED (glue onto
 * the desktop surfaces). The 6 mutating methods are STUBBED — they return a
 * clear "available in a follow-up" ActionResult; the loop degrades gracefully.
 * The confirm gate is BUILT (in assistant-commands.ts) but won't trigger in D1
 * because the mutating actions short-circuit to the stub before the gate.
 * Dispatch 2 fills in the 6 mutating implementations behind the gate.
 */

const MUTATING_NOT_AVAILABLE = 'Mutating actions are enabled in a follow-up update.';

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

	// ---- Act — mutating (confirm-gated; STUBBED in Dispatch 1) ----------

	async startSession(_host: string, _cwd: string, _agent: string): Promise<ActionResult> {
		return ActionResult.error(MUTATING_NOT_AVAILABLE);
	}

	async sendPromptToSession(_sessionName: string, _prompt: string): Promise<ActionResult> {
		return ActionResult.error(MUTATING_NOT_AVAILABLE);
	}

	async createProject(_host: string, _parentPath: string, _folderName: string): Promise<ActionResult> {
		return ActionResult.error(MUTATING_NOT_AVAILABLE);
	}

	async runCommand(_command: string): Promise<ActionResult> {
		return ActionResult.error(MUTATING_NOT_AVAILABLE);
	}

	async createFile(_path: string, _content: string): Promise<ActionResult> {
		return ActionResult.error(MUTATING_NOT_AVAILABLE);
	}

	async cloneRepo(_fullName: string, _folder: string | null): Promise<ActionResult> {
		return ActionResult.error(MUTATING_NOT_AVAILABLE);
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

/** Re-export for type-only consumers in the feature layer. */
export type { FolderResolution, WatchedFolder, PocketShellRepos };
