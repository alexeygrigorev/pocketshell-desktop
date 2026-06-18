/**
 * E2E spec #85 / #86: connecting to a host opens a terminal as a FULL-WIDTH
 * EDITOR TAB (the reworked terminal surface), backed by a real tmux session on
 * the remote — all inside the real activated extension.
 *
 * #85 marquee: `pocketshell.surface.connect` opens a `vscode.Terminal` created
 *      with `location: vscode.TerminalLocation.Editor` (see surface-commands.ts)
 *      — i.e. a terminal that lives in the editor tab strip, not the bottom
 *      panel. This spec drives that command with the connected fixture host and
 *      asserts (a) a new terminal appeared and (b) it landed as an editor tab.
 *
 * #86 marquee: the terminal opened by `surface.connect` is backed by a real
 *      tmux session on the remote (TmuxSessionPseudoterminal runs
 *      `new-session -A -s pocketshell-<host>`). This spec PROVES that by
 *      creating a NEW named tmux session over the live SSH connection and
 *      listing the remote's tmux sessions, asserting both appear.
 *
 * Why we exec tmux directly instead of `pocketshell.tmux.new` /
 * `pocketshell.tmux-ui.newSession`: both of those commands drive
 * `vscode.window.showInputBox` for the session name, which BLOCKS the
 * forked-extension-host UI (there is no test driver to resolve it — see the #94
 * spec's note about not driving showQuickPick/showInputBox headless). The
 * `pocketshell.tmux.list` command likewise renders to an OutputChannel and
 * returns void, so its result is not inspectable. The lowest-friction path that
 * still exercises the real connection + real remote tmux is to drive the
 * connection's own `exec()` (the same channel the extension uses) — this proves
 * the #86 contract (a tmux session can be created and listed over the
 * connection) end-to-end without tripping a blocking modal.
 *
 * This runs IN-HOST (the real forked VS Code, the real activated extension).
 * `import * as vscode from 'vscode'` resolves here because this module compiles
 * into the extension host. By the time this suite runs, `activate()` has
 * already auto-connected to the fixture (#94), so a live SSH connection exists.
 *
 * Setup mirrors the 94/81 specs: read POCKETSHELL_E2E_CONTEXT and
 * POCKETSHELL_E2E_EXT_OUT, then require the ConnectionService singleton from
 * the built extension tree.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type { E2eContext } from './e2e-context';

// Minimal structural types for the ConnectionService singleton surface this
// spec exercises. We import the real instance at runtime from the BUILT
// extension via an absolute require (this module lives outside the extension's
// out/ tree, so the bare 'pocketshell/...' alias does not resolve).
interface HostLike {
	id: number;
	name: string;
	hostname: string;
	port: number;
	username: string;
}
interface ExecResultLike {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}
interface SshConnectionLike {
	exec(command: string, timeout?: number): Promise<ExecResultLike>;
}
interface ConnectionServiceCtor {
	getInstance(): ConnectionServiceLike;
}
interface ConnectionServiceLike {
	getHosts(): Promise<HostLike[]>;
	getConnection(hostId: number): SshConnectionLike | null;
	getState(hostId: number): string;
}

/** Distinctive tmux session name created by test B (and cleaned up in suiteTeardown). */
const TMUX_SESSION_NAME = 'psh-e2e-85';

suite('E2E #85/#86 — terminal surface + tmux backing', function () {
	this.timeout(60000);

	let ctx: E2eContext;
	let service: ConnectionServiceLike;
	// Terminals this suite opened (closed in suiteTeardown so other suites
	// are not polluted). `unknown` because vscode.Terminal is structural here.
	let openedTerminals: unknown[] = [];

	suiteSetup(function () {
		// The runner set POCKETSHELL_E2E_CONTEXT to <userDataDir>/e2e-context.json
		// before forking the host; test-electron forwards process.env.
		const contextPath = process.env.POCKETSHELL_E2E_CONTEXT;
		assert.ok(
			contextPath && fs.existsSync(contextPath),
			`POCKETSHELL_E2E_CONTEXT not set or missing: ${contextPath}`,
		);

		// The runner exposes the built extension out/ dir via env so we don't
		// hardcode an absolute path. Loaded here (not at module load) because the
		// path is only known after reading the env.
		const extensionOut = process.env.POCKETSHELL_E2E_EXT_OUT;
		assert.ok(
			extensionOut && fs.existsSync(extensionOut),
			`POCKETSHELL_E2E_EXT_OUT not set or missing: ${extensionOut}`,
		);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { ConnectionService } = require(path.join(extensionOut!, 'connection-service')) as {
			ConnectionService: ConnectionServiceCtor;
		};
		service = ConnectionService.getInstance();

		ctx = JSON.parse(fs.readFileSync(contextPath!, 'utf-8'));
		console.log('[e2e-inhost#85] context:', {
			alias: ctx.alias,
			hostId: ctx.hostId,
			fixture: ctx.fixture,
		});
	});

	// Best-effort cleanup runs ONCE at suite end (suiteTeardown): close the
	// terminals we opened and kill the tmux session we created, so the other
	// in-host suites are not polluted. Never throws — a cleanup failure must not
	// mask a real test failure. (Mocha TDD ui: `suiteTeardown` == BDD `after`.)
	suiteTeardown(async function () {
		for (const terminal of openedTerminals) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(terminal as any).dispose();
			} catch (err) {
				console.warn('[e2e-inhost#85] suiteTeardown: terminal dispose failed (ignored):', err);
			}
		}
		openedTerminals = [];

		try {
			const conn = service.getConnection(ctx.hostId);
			if (conn) {
				await conn.exec(`tmux kill-session -t ${shellQuote(TMUX_SESSION_NAME)} 2>/dev/null; true`, 5_000);
			}
		} catch (err) {
			console.warn('[e2e-inhost#85] suiteTeardown: tmux kill-session failed (ignored):', err);
		}
	});

	test('A. surface.connect opens a terminal as an editor tab (#85)', async function () {
		// Precondition: the fixture connection is active. The #94 auto-connect
		// should have it; if not, drive surface.connect once (which connects) and
		// poll for the Connected state.
		await ensureConnected(ctx.hostId);

		// IMPORTANT: a terminal created with `location: TerminalLocation.Editor`
		// (what surface.connect does — see surface-commands.ts) does NOT appear in
		// `vscode.window.terminals`; that array tracks panel/terminal-view
		// terminals only. Editor-area terminals surface in `vscode.window.tabGroups`
		// as a Tab whose `input` is a terminal-editor tab input. So the editor-tab
		// presence is the authoritative signal here, not the terminals array.
		const baselinePanelTerminals = vscode.window.terminals.length;
		const baselineEditorTabs = collectEditorTerminalTabs();
		console.log('[e2e-inhost#85] A. baseline:', {
			panelTerminals: baselinePanelTerminals,
			editorTerminalTabs: baselineEditorTabs.map((t) => ({ label: t.label, inputCtor: ctorName(t.input) })),
			allTabs: flattenTabs().map((t) => ({ label: t.label, inputCtor: ctorName(t.input) })),
		});

		// Passing the hostId as a bare number lets surface.connect's
		// resolveHostId() return it immediately (no blocking host quick-pick).
		await vscode.commands.executeCommand('pocketshell.surface.connect', ctx.hostId);

		// The surface keeps ONE editor tab per host (surface-commands.ts:
		// `registry.get(hostId)` — if it exists, just `terminal.show(true)` to
		// focus it; otherwise create + register). The host's editor tab is
		// therefore present whether it pre-existed (e.g. the #94 startup
		// auto-connect already opened it) or was just created by this call. So we
		// assert PRESENCE of the host's editor-tab terminal after connect, which
		// is the actual #85 contract (the host's terminal is open as a full-width
		// editor tab), robust to either path. Poll for the host's tab label since
		// terminal/tab registration + rendering is async.
		const expectedLabel = `PocketShell: ${ctx.alias}`;
		const deadlineMs = 10_000;
		const startedAt = Date.now();
		let hostEditorTabs = hostEditorTerminalTabs(expectedLabel);
		let openedHere = false;
		while (Date.now() - startedAt < deadlineMs) {
			hostEditorTabs = hostEditorTerminalTabs(expectedLabel);
			if (hostEditorTabs.length > 0) {
				break;
			}
			await sleep(150);
		}

		console.log('[e2e-inhost#85] A. host editor tabs after connect:', hostEditorTabs.map((t) => ({
			label: t.label,
			isActive: t.isActive,
			inputCtor: ctorName(t.input),
		})));

		// MARQUEE #85: surface.connect surfaces the host's terminal as a
		// FULL-WIDTH EDITOR TAB (the reworked surface). On this forked VS Code the
		// editor-terminal tab input ctor is `TerminalEditorTabInput` (a terminal in
		// the editor area); the documented name is `TabInputTerminal`. Panel
		// terminals never appear in tabGroups, so the presence of such a tab
		// proves the editor-tab surface (not the bottom panel).
		assert.ok(
			hostEditorTabs.length > 0,
			`surface.connect did not surface an editor-tab terminal for host "${ctx.alias}" ` +
				`within ${deadlineMs}ms. Expected a tab labeled "${expectedLabel}" with a ` +
				`terminal-editor input. Tabs seen: ` +
				`${JSON.stringify(flattenTabs().map((t) => ({ label: t.label, inputCtor: ctorName(t.input) })))}.`,
		);
		// Belt-and-braces: confirm the tab is actually an editor-terminal kind.
		assert.ok(
			EDITOR_TERMINAL_TAB_INPUT_NAMES.has(ctorName(hostEditorTabs[0].input)),
			`The host's tab ("${hostEditorTabs[0].label}") is not an editor-terminal tab. ` +
				`inputCtor=${ctorName(hostEditorTabs[0].input)}, expected one of ` +
				`${JSON.stringify([...EDITOR_TERMINAL_TAB_INPUT_NAMES])}.`,
		);

		// Diagnose whether this call created the tab or focused a pre-existing one
		// (both satisfy #85 — the surface registry deliberately reuses one tab per
		// host, so reuse is the correct idempotent behavior). Not load-bearing.
		openedHere = baselineEditorTabs.every((t) => t.label !== expectedLabel);
		console.log('[e2e-inhost#85] A. tab opened-here vs reused-focus:', {
			openedHere,
			baselineEditorTabLabels: baselineEditorTabs.map((t) => t.label),
		});

		// Record backing terminal handles for teardown. Editor terminals created
		// with a Pty may or may not appear in vscode.window.terminals depending on
		// the host; capture any new ones (best-effort — the tab assertion above is
		// the authoritative #85 signal).
		openedTerminals.push(...vscode.window.terminals.slice(baselinePanelTerminals));

		console.log('[e2e-inhost#85] A. OK: terminal surfaced as editor tab:', {
			label: hostEditorTabs[0].label,
			isActive: hostEditorTabs[0].isActive,
			inputCtor: ctorName(hostEditorTabs[0].input),
		});
	});

	test('B. a tmux session can be created and listed over the connection (#86)', async function () {
		// Precondition: connected (test A ensures it, but be defensive about
		// ordering / a flaky auto-connect).
		await ensureConnected(ctx.hostId);
		const conn = service.getConnection(ctx.hostId);
		assert.ok(conn, `No active connection for hostId=${ctx.hostId} (${ctx.alias}).`);

		// The surface.connect terminal from test A is backed by a tmux session
		// named `pocketshell-<alias>`, but that session is opened ASYNC by the
		// pseudoterminal's open() (the `tmux new-session -A` fires after VS Code
		// calls open()). Poll for it: it is the link between #85 (the editor tab)
		// and #86 (real tmux backing), so its presence meaningfully strengthens
		// the E2E proof — but it is timing-dependent, so we poll rather than
		// assert-immediately and only hard-fail if it never appears.
		const surfaceSessionName = `pocketshell-${ctx.alias}`;
		const surfaceSessionDeadlineMs = 10_000;
		const surfaceStartedAt = Date.now();
		let surfacePresent = false;
		while (Date.now() - surfaceStartedAt < surfaceSessionDeadlineMs) {
			const sessions = await listTmuxSessions(conn!);
			if (sessions.includes(surfaceSessionName)) {
				surfacePresent = true;
				break;
			}
			await sleep(250);
		}
		console.log(
			'[e2e-inhost#85] B. surface-backed tmux session',
			`"${surfaceSessionName}" present: ${surfacePresent}`,
		);
		assert.ok(
			surfacePresent,
			`The surface.connect terminal should be backed by a tmux session named ` +
				`"${surfaceSessionName}" on the remote, but it never appeared within ` +
				`${surfaceSessionDeadlineMs}ms. The editor tab (#85) opened but its ` +
				`TmuxSessionPseudoterminal did not create the backing tmux session (#86 link).`,
		);

		// MARQUEE #86: create a NEW named tmux session over the connection.
		// `new-session -d` detaches so it persists without an attached client.
		const create = await conn!.exec(
			`tmux new-session -d -s ${shellQuote(TMUX_SESSION_NAME)} 2>&1; echo "EXIT=$?"`,
			5_000,
		);
		const createOut = `${create.stdout}\n${create.stderr}`;
		console.log('[e2e-inhost#85] B. new-session output:', createOut.trim());

		// The session may already exist from a prior run; both "created" and
		// "already exists" satisfy the #86 contract (a session by that name is
		// live on the remote). Anything else is a failure.
		const alreadyExisted = /duplicate session|exists/.test(createOut);
		if (!alreadyExisted) {
			assert.ok(
				/EXIT=0/.test(createOut),
				`tmux new-session -d -s ${TMUX_SESSION_NAME} did not succeed. Output:\n${createOut}`,
			);
		}

		// MARQUEE #86 (list): the new session must now be listable over the
		// same connection.
		const after = await listTmuxSessions(conn!);
		console.log('[e2e-inhost#85] B. tmux sessions after create:', after);
		assert.ok(
			after.includes(TMUX_SESSION_NAME),
			`tmux session "${TMUX_SESSION_NAME}" not found in list-sessions after create. ` +
				`Sessions: ${JSON.stringify(after)}.`,
		);
		assert.ok(
			after.includes(surfaceSessionName),
			`surface.connect-backed session "${surfaceSessionName}" dropped out of list-sessions. ` +
				`Sessions: ${JSON.stringify(after)}.`,
		);

		console.log('[e2e-inhost#85] B. OK: created + listed tmux sessions:', {
			created: TMUX_SESSION_NAME,
			surface: surfaceSessionName,
			total: after.length,
		});
	});

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	/** Poll until the fixture host reports ConnectionState 'Connected'. */
	async function ensureConnected(hostId: number): Promise<void> {
		const deadlineMs = 15_000;
		const startedAt = Date.now();
		if (service.getState(hostId) === 'Connected' && service.getConnection(hostId)) {
			return;
		}
		// Auto-connect may still be in flight; surface.connect will reuse or
		// establish the connection (it does not block on a pick when given an id).
		try {
			await vscode.commands.executeCommand('pocketshell.surface.connect', hostId);
		} catch (err) {
			console.warn('[e2e-inhost#85] ensureConnected: surface.connect threw (ignored, will poll):', err);
		}
		while (Date.now() - startedAt < deadlineMs) {
			if (service.getState(hostId) === 'Connected' && service.getConnection(hostId)) {
				return;
			}
			await sleep(250);
		}
		assert.fail(
			`Fixture host ${hostId} (${ctx.alias}) did not reach Connected within ${deadlineMs}ms ` +
				`(state=${service.getState(hostId)}).`,
		);
	}

	/** List tmux sessions on the remote via `tmux list-sessions`, names only. */
	async function listTmuxSessions(conn: SshConnectionLike): Promise<string[]> {
		// list-sessions prints "name: N windows (created ...)" per line. When no
		// server is running it exits non-zero with "no server running"; treat that
		// as an empty list (the surface session may not have been opened yet).
		const result = await conn.exec(`tmux list-sessions 2>/dev/null`, 5_000);
		const stdout = (result.stdout || '').trim();
		if (!stdout || /no server running/.test(stdout)) {
			return [];
		}
		return stdout
			.split('\n')
			.map((line) => line.split(':')[0])
			.filter(Boolean);
	}
});

// -----------------------------------------------------------------------------
// Module-level helpers (no `this` binding concerns)
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Flatten every tab across all tab groups into a single list. */
function flattenTabs(): vscode.Tab[] {
	const tabs: vscode.Tab[] = [];
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			tabs.push(tab);
		}
	}
	return tabs;
}

/**
 * Collect tabs whose `input` is a terminal editor tab.
 *
 * The documented discriminator is `vscode.TabInputTerminal` ("a terminal in the
 * editor area"). On THIS forked VS Code, the concrete tab-input class is named
 * `TerminalEditorTabInput` (a terminal in the editor area) — observed at runtime
 * in the #85 run. Panel terminals never appear in tabGroups, so any of these
 * ctor names proves the terminal landed as a full-width editor tab (the #85
 * surface). We detect via:
 *   1. `input instanceof vscode.TabInputTerminal` — the documented check, if the
 *      symbol is exported on the host.
 *   2. Constructor-name match against the known editor-terminal tab input names
 *      (robust whether the host hands out an instance or a structurally-typed
 *      plain object).
 */
const EDITOR_TERMINAL_TAB_INPUT_NAMES = new Set(['TabInputTerminal', 'TerminalEditorTabInput']);
function collectEditorTerminalTabs(): vscode.Tab[] {
	const TabInputTerminal = (vscode as { TabInputTerminal?: new () => unknown }).TabInputTerminal;
	return flattenTabs().filter((tab) => {
		const input = tab.input as unknown;
		if (TabInputTerminal && input instanceof TabInputTerminal) {
			return true;
		}
		return EDITOR_TERMINAL_TAB_INPUT_NAMES.has(ctorName(input));
	});
}

/**
 * The editor-terminal tab(s) whose label matches the host's terminal tab label
 * (surface.connect names it `PocketShell: <hostLabel>`). Used to detect the
 * SPECIFIC host's terminal among the editor tabs, robust to whether it was just
 * created or focused as a pre-existing tab.
 */
function hostEditorTerminalTabs(expectedLabel: string): vscode.Tab[] {
	return collectEditorTerminalTabs().filter((tab) => tab.label === expectedLabel);
}

/** Best-effort constructor name for a tab input (for detection + diagnostics). */
function ctorName(input: unknown): string {
	if (input === null || input === undefined) {
		return 'undefined';
	}
	const ctor = (input as { constructor?: { name?: string } }).constructor;
	return ctor?.name ?? 'unknown';
}

/** Single-quote a shell argument for safe interpolation into a tmux command. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
