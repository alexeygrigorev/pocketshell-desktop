/**
 * Fake-backed tests for the action-assistant MUTATING tools (Dispatch 2).
 *
 * These instantiate `DesktopAssistantActions` with fakes for the
 * ConnectionService, the surface/tmux-ui registries, the active-pane pty, and
 * the SSH connection (stub `exec`), then assert each of the 6 mutating action
 * methods reaches the right surface:
 *
 *   - createProject → conn.exec receives the quoted `mkdir -p` command.
 *   - createFile    → heredoc fallback path → conn.exec receives the heredoc.
 *   - cloneRepo     → conn.exec receives the `pocketshell repos clone` command.
 *   - runCommand    → the active pty's sendTextToActivePane(submit=true) is hit.
 *   - sendPromptToSession → the named session's pty sendTextToActivePane(true).
 *   - startSession  → the launcher creates a vscode terminal (mocked).
 *
 * Plus the security guards (path-traversal / unsafe folder-name rejection) and
 * the no-active-session error paths. The loop/gate/catalog are unchanged (D1);
 * these tests cover the action SEAM the loop calls after the gate confirms.
 *
 * `vscode` is minimally mocked (EventEmitter + ThemeIcon + window.createTerminal
 * + l10n.t + Uri) — the same pattern as share-receptors.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- vscode mock (must be hoisted before the SUT import) ---------------------
// DesktopAssistantActions + session-launcher + SshPseudoterminal import vscode.
// We model only the surface the mutating actions + launcher touch.
vi.mock('vscode', () => {
	class EventEmitter<T> {
		private listeners: ((e: T) => void)[] = [];
		readonly event = (listener: (e: T) => void) => {
			this.listeners.push(listener);
			return { dispose: () => {
				this.listeners = this.listeners.filter((l) => l !== listener);
			} };
		};
		fire(e: T): void { for (const l of this.listeners) l(e); }
		dispose(): void { this.listeners = []; }
	}
	class ThemeIcon { constructor(readonly id: string, readonly color?: unknown) {} }
	class Uri {
		constructor(readonly scheme: string, readonly path: string) {}
		static parse(value: string): Uri {
			const m = /^([\w-]+):\/\/?(.*)$/.exec(value);
			return m ? new Uri(m[1], m[2]) : new Uri('file', value);
		}
		static file(path: string): Uri { return new Uri('file', path); }
		get fsPath(): string { return this.path; }
		toString(): string { return `${this.scheme}://${this.path}`; }
	}
	const showErrorMessage = vi.fn(async () => undefined);
	const l10n = { t: (msg: string, ...args: unknown[]) => args.reduce((s, a, i) => s.replace(`{${i}}`, String(a)), msg) };
	return {
		EventEmitter,
		ThemeIcon,
		Uri,
		l10n,
		window: {
			createTerminal: vi.fn((opts: unknown) => ({
				__opts: opts,
				show: vi.fn(() => {}),
				dispose: vi.fn(() => {}),
			})),
			showErrorMessage,
			onDidChangeActiveTerminal: vi.fn(() => ({ dispose: () => {} })),
			onDidCloseTerminal: vi.fn(() => ({ dispose: () => {} })),
		},
		commands: { executeCommand: vi.fn(async () => undefined) },
	};
});

// Mock the session-launcher module so startSession can be tested without faking
// the tmux -CC protocol. Hoisted before the SUT import (vi.mock is hoisted).
vi.mock('../../../../extensions/pocketshell/src/feature/sessions/session-launcher', () => ({
	launchTmuxSession: vi.fn(async () => ({ ok: true, result: { sessionName: 's', terminal: {} } })),
	resolveLaunchConnection: vi.fn(async () => null),
}));

import { DesktopAssistantActions } from '../../../../extensions/pocketshell/src/feature/assistant/desktop-assistant-actions';
import type { SshConnection, ExecResult } from '../../../../extensions/pocketshell/src/backend/ssh/connection/ssh-client';
import type { ConnectionService } from '../../../../extensions/pocketshell/src/connection-service';
import type { Host } from '../../../../extensions/pocketshell/src/backend/ssh/data/host-store';
import * as launcherMock from '../../../../extensions/pocketshell/src/feature/sessions/session-launcher';
import { AssistantAgentLoop } from '../../../../src/assistant/assistant-agent-loop';
import type { CompleteResult, LlmResponse } from '../../../../src/assistant/llm-types';

// ---- fakes ------------------------------------------------------------------

/** A fake SshConnection that records exec calls + returns scripted results. */
interface FakeConn extends SshConnection {
	exec: ReturnType<typeof vi.fn>;
	shell: ReturnType<typeof vi.fn>;
	connected: boolean;
}

function makeFakeConn(execImpl?: (cmd: string, timeout?: number) => Promise<ExecResult>): FakeConn {
	const defaultExec = vi.fn(async (_cmd: string, _timeout?: number): Promise<ExecResult> => ({
		exitCode: 0, stdout: '/home/user/proj\n', stderr: '',
	}));
	return {
		connected: true,
		exec: execImpl ? vi.fn(execImpl) : defaultExec,
		shell: vi.fn(async () => ({ write: vi.fn(), close: vi.fn() })),
	} as unknown as FakeConn;
}

/** A fake pty whose sendTextToActivePane records its calls. */
interface FakePty {
	sendTextToActivePane: ReturnType<typeof vi.fn>;
	getActivePaneMetadata: ReturnType<typeof vi.fn>;
}
function makeFakePty(): FakePty {
	return {
		sendTextToActivePane: vi.fn(async () => {}),
		getActivePaneMetadata: vi.fn(() => ({ cwd: '/home/user', paneId: '%5' })),
	};
}

/** A fake surface registry with a controllable list + pty lookup. */
function makeSurfaceRegistry(entries: Array<{ hostId: number; hostLabel: string; sessionName: string; terminal: unknown; pty?: FakePty }>) {
	const ptyMap = new Map<string, FakePty>();
	for (const e of entries) if (e.pty) ptyMap.set(`${e.hostId}:${e.sessionName}`, e.pty);
	return {
		list: () => entries.map(({ pty, ...rest }) => rest),
		getPty: (hostId: number, sessionName?: string) =>
			sessionName !== undefined ? ptyMap.get(`${hostId}:${sessionName}`) : undefined,
	};
}

/** A fake tmux-ui registry with controllable entries. */
function makeTmuxRegistry(entries: Array<{ hostId: number; hostLabel: string; sessionName: string; pty: FakePty }>) {
	return {
		entries: () => entries,
	};
}

/** Build a fake ConnectionService with a single connected host. */
function makeFakeService(conn: FakeConn, host: Host): Pick<ConnectionService, 'getHosts' | 'getHost' | 'getConnection' | 'getWatchedFolders'> {
	return {
		getHosts: vi.fn(async () => [host]),
		getHost: vi.fn(async (id: number) => (id === host.id ? host : undefined)),
		getConnection: vi.fn((id: number) => (id === host.id ? conn : undefined)),
		getWatchedFolders: vi.fn(async () => []),
	};
}

const HOST: Host = { id: 7, name: 'prod', hostname: 'prod.example.com' } as unknown as Host;

// ---- tests ------------------------------------------------------------------

describe('DesktopAssistantActions — createProject', () => {
	it('runs the quoted mkdir -p command and returns the created path', async () => {
		const conn = makeFakeConn();
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const result = await actions.createProject('prod', '/home/user', 'my-proj');
		expect(result.ok).toBe(true);
		expect(result.message).toBe('Created project /home/user/my-proj.');
		expect(conn.exec).toHaveBeenCalledTimes(1);
		expect(conn.exec).toHaveBeenCalledWith("mkdir -p '/home/user/my-proj'", 10_000);
	});

	it('REJECTS a parent path with a .. segment (no exec)', async () => {
		const conn = makeFakeConn();
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const result = await actions.createProject('prod', '/home/user/../etc', 'evil');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('..');
		expect(conn.exec).not.toHaveBeenCalled();
	});

	it('REJECTS an unsafe folder name (slashes / leading dash)', async () => {
		const conn = makeFakeConn();
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const slash = await actions.createProject('prod', '/home/user', 'a/b');
		expect(slash.ok).toBe(false);
		expect(slash.message).toContain('folder name');
		const dash = await actions.createProject('prod', '/home/user', '-rf');
		expect(dash.ok).toBe(false);
		expect(conn.exec).not.toHaveBeenCalled();
	});

	it('surfaces a non-zero exit as an error', async () => {
		const conn = makeFakeConn(async () => ({ exitCode: 1, stdout: '', stderr: 'permission denied' }));
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const result = await actions.createProject('prod', '/home/user', 'proj');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('permission denied');
	});

	it('returns an error for an unknown host', async () => {
		const conn = makeFakeConn();
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const result = await actions.createProject('unknown-host', '/home/user', 'proj');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('Unknown host');
		expect(conn.exec).not.toHaveBeenCalled();
	});
});

describe('DesktopAssistantActions — runCommand (active-pane interactive send)', () => {
	it('sends the command to the active session pty with submit=true', async () => {
		const pty = makeFakePty();
		const surface = makeSurfaceRegistry([
			{ hostId: 7, hostLabel: 'prod', sessionName: 'proj', terminal: {}, pty: pty as unknown as FakePty },
		]);
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(makeFakeConn(), HOST) as ConnectionService,
			surfaceRegistry: surface as unknown as Parameters<typeof DesktopAssistantActions>[0]['surfaceRegistry'],
		});
		const result = await actions.runCommand('ls -la');
		expect(result.ok).toBe(true);
		expect(result.message).toBe('Ran: ls -la');
		expect(pty.sendTextToActivePane).toHaveBeenCalledWith('ls -la', true);
	});

	it('returns an error when no active session/pty exists (directing to start_session)', async () => {
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(makeFakeConn(), HOST) as ConnectionService,
		});
		const result = await actions.runCommand('ls');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('start_session');
	});
});

describe('DesktopAssistantActions — sendPromptToSession (named-session interactive send)', () => {
	it('sends the prompt to the named session pty with submit=true', async () => {
		const pty = makeFakePty();
		const surface = makeSurfaceRegistry([
			{ hostId: 7, hostLabel: 'prod', sessionName: 'my-sess', terminal: {}, pty: pty as unknown as FakePty },
		]);
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(makeFakeConn(), HOST) as ConnectionService,
			surfaceRegistry: surface as unknown as Parameters<typeof DesktopAssistantActions>[0]['surfaceRegistry'],
		});
		const result = await actions.sendPromptToSession('my-sess', 'refactor this');
		expect(result.ok).toBe(true);
		expect(result.message).toContain('my-sess');
		expect(pty.sendTextToActivePane).toHaveBeenCalledWith('refactor this', true);
	});

	it('falls back to the tmux-ui registry when the surface registry misses', async () => {
		const pty = makeFakePty();
		const tmux = makeTmuxRegistry([
			{ hostId: 7, hostLabel: 'prod', sessionName: 'tmux-sess', pty: pty },
		]);
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(makeFakeConn(), HOST) as ConnectionService,
			tmuxRegistry: tmux as unknown as Parameters<typeof DesktopAssistantActions>[0]['tmuxRegistry'],
		});
		const result = await actions.sendPromptToSession('tmux-sess', 'do thing');
		expect(result.ok).toBe(true);
		expect(pty.sendTextToActivePane).toHaveBeenCalledWith('do thing', true);
	});

	it('returns an error directing to start_session when no matching open session', async () => {
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(makeFakeConn(), HOST) as ConnectionService,
		});
		const result = await actions.sendPromptToSession('nope', 'hi');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('start_session');
	});

	it('rejects an empty prompt', async () => {
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(makeFakeConn(), HOST) as ConnectionService,
		});
		const result = await actions.sendPromptToSession('sess', '');
		expect(result.ok).toBe(false);
	});
});

describe('DesktopAssistantActions — createFile (heredoc fallback)', () => {
	beforeEach(() => {
		// Force the SFTP path to be unavailable so createFile falls back to the
		// heredoc exec path (which we can assert on conn.exec). We do this by
		// making the dynamic import of sftp-client throw on connect.
		vi.resetModules();
	});

	it('writes via the quoted-delimiter heredoc when SFTP is unavailable', async () => {
		// Stub the sftp-client dynamic import so connect() throws → heredoc fallback.
		vi.doMock('../../../../extensions/pocketshell/src/backend/files/sftp-client', () => ({
			SftpClient: class {
				async connect() { throw new Error('sftp unavailable'); }
				disconnect() {}
			},
		}));
		const conn = makeFakeConn();
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const result = await actions.createFile('/home/user/file.txt', 'hello $HOME `whoami`');
		expect(result.ok).toBe(true);
		expect(result.message).toBe('Created /home/user/file.txt.');
		expect(conn.exec).toHaveBeenCalledTimes(1);
		const [cmd] = conn.exec.mock.calls[0];
		// Content must appear VERBATIM (no shell expansion).
		expect(cmd).toContain('hello $HOME `whoami`');
		// Path must be quoted.
		expect(cmd).toContain("cat > '/home/user/file.txt'");
		// Quoted-delimiter heredoc.
		expect(cmd).toContain("<<'POCKETSHELL_EOF'");
	});

	it('REJECTS a target path with a .. segment (no exec)', async () => {
		vi.doMock('../../../../extensions/pocketshell/src/backend/files/sftp-client', () => ({
			SftpClient: class { async connect() { throw new Error('no'); } disconnect() {} },
		}));
		const conn = makeFakeConn();
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const result = await actions.createFile('../etc/passwd', 'x');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('..');
		expect(conn.exec).not.toHaveBeenCalled();
	});
});

describe('DesktopAssistantActions — cloneRepo', () => {
	it('runs pocketshell repos clone with the resolved target root', async () => {
		const conn = makeFakeConn(async (cmd: string) => ({
			exitCode: 0,
			stdout: '/home/user/git/proj\n',
			stderr: '',
		}));
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const result = await actions.cloneRepo('owner/proj', null);
		expect(result.ok).toBe(true);
		expect(result.message).toContain('owner/proj');
		expect(result.message).toContain('/home/user/git/proj');
		expect(conn.exec).toHaveBeenCalledTimes(1);
		const cmd = conn.exec.mock.calls[0][0] as string;
		// Server-side pocketshell repos CLI, fullName + root quoted.
		expect(cmd).toContain('pocketshell repos clone');
		expect(cmd).toContain("'owner/proj'");
	});

	it('surfaces a clear error when pocketshell repos is not installed (exit 127)', async () => {
		const conn = makeFakeConn(async () => ({
			exitCode: 127,
			stdout: '',
			stderr: 'pocketshell: command not found\n',
		}));
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const result = await actions.cloneRepo('owner/proj', null);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('not installed');
	});

	it('REJECTS a fullName with a .. segment', async () => {
		const conn = makeFakeConn();
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const result = await actions.cloneRepo('..', null);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('..');
	});
});

describe('DesktopAssistantActions — startSession (launcher wiring)', () => {
	// startSession delegates to launchTmuxSession. The session-launcher module
	// is mocked at the top of the file so we can assert the action passes the
	// right (host, cwd, kind) and surfaces the launcher's ok/error result,
	// without faking the full tmux -CC protocol.
	beforeEach(() => {
		vi.mocked(launcherMock.launchTmuxSession).mockReset();
		vi.mocked(launcherMock.resolveLaunchConnection).mockReset();
	});

	it('maps the agent name, resolves the host, and calls launchTmuxSession', async () => {
		const conn = makeFakeConn();
		vi.mocked(launcherMock.resolveLaunchConnection).mockResolvedValue({
			conn,
			host: { id: 7, name: 'prod', hostname: 'prod.example.com' },
		});
		vi.mocked(launcherMock.launchTmuxSession).mockResolvedValue({
			ok: true,
			result: { sessionName: 'myapp-codex', terminal: {} },
		});
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const result = await actions.startSession('prod', '/home/user/myapp', 'codex');
		expect(result.ok).toBe(true);
		expect(result.message).toContain('codex');
		expect(result.message).toContain('myapp-codex');
		// resolveLaunchConnection was called with the resolved host id.
		expect(launcherMock.resolveLaunchConnection).toHaveBeenCalledTimes(1);
		expect(launcherMock.resolveLaunchConnection).toHaveBeenCalledWith(expect.anything(), 7);
		// launchTmuxSession was called with the resolved conn + host + cwd + kind.
		expect(launcherMock.launchTmuxSession).toHaveBeenCalledTimes(1);
		const [passedConn, passedHost, cwd, kind] = vi.mocked(launcherMock.launchTmuxSession).mock.calls[0];
		expect(passedConn).toBe(conn);
		expect(passedHost.name).toBe('prod');
		expect(cwd).toBe('/home/user/myapp');
		expect(kind).toBe('codex');
	});

	it('surfaces a launcher failure as an error', async () => {
		const conn = makeFakeConn();
		vi.mocked(launcherMock.resolveLaunchConnection).mockResolvedValue({
			conn,
			host: { id: 7, name: 'prod', hostname: 'prod.example.com' },
		});
		vi.mocked(launcherMock.launchTmuxSession).mockResolvedValue({
			ok: false,
			message: 'tmux send-keys failed: oops',
		});
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const result = await actions.startSession('prod', '/home/user/app', 'shell');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('tmux send-keys failed');
	});

	it('rejects an unknown agent name (no launcher call)', async () => {
		const conn = makeFakeConn();
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(conn, HOST) as ConnectionService,
		});
		const result = await actions.startSession('prod', '/home/user/app', 'gemini');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('Unknown agent');
		expect(launcherMock.launchTmuxSession).not.toHaveBeenCalled();
	});

	it('returns an error for an unknown host', async () => {
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(makeFakeConn(), HOST) as ConnectionService,
		});
		const result = await actions.startSession('nope', '/home/user/app', 'shell');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('Unknown host');
	});
});

/**
 * End-to-end gate-is-live verification (Dispatch 2): the REAL
 * AssistantAgentLoop wired to the REAL DesktopAssistantActions (with fakes for
 * the SSH/tmux surfaces). Proves the confirm gate is now LIVE — a mutating
 * call flows model → CommandSafety (run_command) → confirm gate → real action.
 * In D1 these short-circuited to the "not available" stub; now they execute.
 */
describe('Action-assistant — confirm gate is LIVE (loop × DesktopAssistantActions)', () => {
	// We use the canonical loop + actions interface; DesktopAssistantActions is
	// the real production seam. The fakes provide the active pty + connection.
	function toolCallResponse(calls: { id: string; name: string; args: string }[]): CompleteResult {
		const response: LlmResponse = {
			text: null,
			toolCalls: calls.map((c) => ({ id: c.id, name: c.name, argumentsJson: c.args })),
			stopReason: 'tool_use',
		};
		return { ok: true, response };
	}
	function textResponse(text: string): CompleteResult {
		const response: LlmResponse = { text, toolCalls: [], stopReason: 'end_turn' };
		return { ok: true, response };
	}
	function fakeClient(responses: CompleteResult[]) {
		let i = 0;
		return {
			async complete() {
				const r = responses[Math.min(i, responses.length - 1)];
				i++;
				return r;
			},
		};
	}

	it('an APPROVED run_command reaches the real action (active pty, submit=true)', async () => {
		const pty = makeFakePty();
		const surface = makeSurfaceRegistry([
			{ hostId: 7, hostLabel: 'prod', sessionName: 'proj', terminal: {}, pty: pty as unknown as FakePty },
		]);
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(makeFakeConn(), HOST) as ConnectionService,
			surfaceRegistry: surface as unknown as Parameters<typeof DesktopAssistantActions>[0]['surfaceRegistry'],
		});
		const loop = new AssistantAgentLoop({
			client: fakeClient([
				toolCallResponse([{ id: 'c1', name: 'run_command', args: JSON.stringify({ command: 'ls -la' }) }]),
				textResponse('Done.'),
			]),
			actions,
		});
		const outcome = await loop.run('list files', {
			confirmGate: async () => ({ kind: 'confirm' }),
		});
		expect(outcome.kind).toBe('answer');
		// The real runCommand was reached (pty.sendTextToActivePane, submit=true).
		expect(pty.sendTextToActivePane).toHaveBeenCalledWith('ls -la', true);
	});

	it('a CANCELLED run_command aborts without touching the pty', async () => {
		const pty = makeFakePty();
		const surface = makeSurfaceRegistry([
			{ hostId: 7, hostLabel: 'prod', sessionName: 'proj', terminal: {}, pty: pty as unknown as FakePty },
		]);
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(makeFakeConn(), HOST) as ConnectionService,
			surfaceRegistry: surface as unknown as Parameters<typeof DesktopAssistantActions>[0]['surfaceRegistry'],
		});
		const loop = new AssistantAgentLoop({
			client: fakeClient([
				toolCallResponse([{ id: 'c1', name: 'run_command', args: JSON.stringify({ command: 'rm temp.log' }) }]),
			]),
			actions,
		});
		const outcome = await loop.run('clean up', { confirmGate: async () => ({ kind: 'cancel' }) });
		expect(outcome.kind).toBe('cancelled');
		expect(pty.sendTextToActivePane).not.toHaveBeenCalled();
	});

	it('a CORRECTED run_command replans, then the revised command executes on confirm', async () => {
		const pty = makeFakePty();
		const surface = makeSurfaceRegistry([
			{ hostId: 7, hostLabel: 'prod', sessionName: 'proj', terminal: {}, pty: pty as unknown as FakePty },
		]);
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(makeFakeConn(), HOST) as ConnectionService,
			surfaceRegistry: surface as unknown as Parameters<typeof DesktopAssistantActions>[0]['surfaceRegistry'],
		});
		// Turn 1: model proposes `rm x`; user corrects → replan.
		// Turn 2: model revises to `rm -i x`; user confirms → executes the REVISED.
		// Turn 3: model answers.
		const loop = new AssistantAgentLoop({
			client: fakeClient([
				toolCallResponse([{ id: 'c1', name: 'run_command', args: JSON.stringify({ command: 'rm x' }) }]),
				toolCallResponse([{ id: 'c2', name: 'run_command', args: JSON.stringify({ command: 'rm -i x' }) }]),
				textResponse('Done.'),
			]),
			actions,
		});
		let gateCall = 0;
		const outcome = await loop.run('remove x', {
			confirmGate: async () => {
				gateCall++;
				// First gate visit: correct. Second: confirm.
				return gateCall === 1 ? { kind: 'correct', correction: 'use -i' } : { kind: 'confirm' };
			},
		});
		expect(outcome.kind).toBe('answer');
		// The FIRST candidate (rm x) must NOT have been executed; only the revised.
		expect(pty.sendTextToActivePane).toHaveBeenCalledTimes(1);
		expect(pty.sendTextToActivePane).toHaveBeenCalledWith('rm -i x', true);
	});

	it('CommandSafety blocks a dangerous run_command BEFORE the gate (no pty call)', async () => {
		const pty = makeFakePty();
		const surface = makeSurfaceRegistry([
			{ hostId: 7, hostLabel: 'prod', sessionName: 'proj', terminal: {}, pty: pty as unknown as FakePty },
		]);
		const actions = new DesktopAssistantActions({
			connectionService: makeFakeService(makeFakeConn(), HOST) as ConnectionService,
			surfaceRegistry: surface as unknown as Parameters<typeof DesktopAssistantActions>[0]['surfaceRegistry'],
		});
		const gateHit = vi.fn(async () => ({ kind: 'confirm' as const }));
		const loop = new AssistantAgentLoop({
			client: fakeClient([
				toolCallResponse([{ id: 'c1', name: 'run_command', args: JSON.stringify({ command: 'sudo rm -rf /' }) }]),
				textResponse('Done.'),
			]),
			actions,
		});
		const outcome = await loop.run('wipe it', { confirmGate: gateHit });
		expect(outcome.kind).toBe('answer');
		// Safety blocked before the gate — gate never surfaced, pty untouched.
		expect(gateHit).not.toHaveBeenCalled();
		expect(pty.sendTextToActivePane).not.toHaveBeenCalled();
	});
});

