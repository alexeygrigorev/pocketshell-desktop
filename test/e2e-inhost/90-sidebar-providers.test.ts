/**
 * E2E spec #90: conversation + prompt-composer sidebar providers.
 *
 * MARQUEE assertions: both sidebar webview views (#90) are registered, open
 * without error, and expose a readable model snapshot via the TestBridge
 * commands. This proves the two provider instances are LIVE and that the
 * bridge wires to them (not stubs).
 *
 * This runs IN-HOST (the real forked VS Code, the real activated extension).
 * By the time this suite runs, `activate()` has already fired — the FEATURES
 * array has registered both sidebar providers via their register helpers, and
 * the `registerProvidersTestBridge()` call (gated on POCKETSHELL_E2E === '1')
 * has wired the `pocketshell.__test.<name>.getState` commands to those live
 * instances.
 *
 * The full pipeline under test:
 *   activate()
 *     → FEATURES[].register() (conversation + prompt-composer)
 *       → registerConversationSidebar / registerPromptComposerSidebar
 *         → new <Provider>(...) + registerWebviewViewProvider(<viewId>, provider)
 *         → provider instance captured in the command module (module-level var)
 *     → registerProvidersTestBridge()
 *       → vscode.commands 'pocketshell.__test.conversation.getState'
 *       → vscode.commands 'pocketshell.__test.promptComposer.getState'
 *
 * We open the views via the auto-generated `<viewId>.focus` commands (VS Code
 * synthesizes these for every contributed webview view) after revealing the
 * PocketShell activity-bar container, then assert none throw and that the
 * bridge returns the expected viewId.
 *
 * TDD ui (suite/test/suiteSetup/suiteTeardown ONLY — no BDD describe/afterEach).
 */

import * as assert from 'assert';
import * as fs from 'fs';

import * as vscode from 'vscode';

import type { E2eContext } from './e2e-context';

/** View ids contributed in package.json `contributes.views.pocketshell`. */
const CONVERSATION_VIEW_ID = 'pocketshell.conversation.sidebar';
const PROMPT_COMPOSER_VIEW_ID = 'pocketshell.promptComposer.sidebar';

/** Minimal structural shape of the TestBridge getState snapshot. */
interface ProviderState {
	viewId: string;
	/** Present only when the bridge or provider threw — distinguishes a wiring
	 * failure from a passing (but empty) model. */
	error?: string;
	visible?: boolean;
	resolved?: boolean;
	session?: unknown;
	ambiguous?: boolean;
	hasConnection?: boolean;
	status?: { kind: string; message?: string; error?: string };
	revision?: number;
}

suite('E2E #90 — conversation + prompt-composer sidebar providers', function () {
	this.timeout(60000);

	let ctx: E2eContext;

	suiteSetup(function () {
		// The runner set POCKETSHELL_E2E_CONTEXT to <userDataDir>/e2e-context.json
		// before forking the host; test-electron forwards process.env.
		const contextPath = process.env.POCKETSHELL_E2E_CONTEXT;
		assert.ok(
			contextPath && fs.existsSync(contextPath),
			`POCKETSHELL_E2E_CONTEXT not set or missing: ${contextPath}`,
		);
		ctx = JSON.parse(fs.readFileSync(contextPath!, 'utf-8'));

		// The runner exposes the built extension out/ dir via env. We don't
		// require it for this spec (we drive the bridge via vscode.commands),
		// but we assert it for parity with the sibling specs and so a missing
		// build is caught loudly rather than as an opaque bridge-absent failure.
		const extensionOut = process.env.POCKETSHELL_E2E_EXT_OUT;
		assert.ok(
			extensionOut && fs.existsSync(extensionOut),
			`POCKETSHELL_E2E_EXT_OUT not set or missing: ${extensionOut}`,
		);

		console.log('[e2e-inhost#90] context:', {
			alias: ctx.alias,
			hostId: ctx.hostId,
		});
	});

	test('A. conversation + prompt-composer views open without error (#90)', async function () {
		// Reveal the PocketShell activity-bar container so both sidebar views
		// become visible (their providers only render when visible). This is the
		// same command extension.ts uses at startup.
		await vscode.commands.executeCommand('workbench.view.extension.pocketshell');

		// VS Code auto-synthesizes a `<viewId>.focus` command for every
		// contributed view. Executing it opens/focuses the view and triggers
		// resolveWebviewView on the provider. Assert neither throws.
		await vscode.commands.executeCommand(`${CONVERSATION_VIEW_ID}.focus`);
		await vscode.commands.executeCommand(`${PROMPT_COMPOSER_VIEW_ID}.focus`);

		// Give the providers a tick to run their async resolveWebviewView +
		// refreshAttribution path before the bridge reads them in test B.
		await sleep(500);

		console.log('[e2e-inhost#90] both sidebar views focused without error');
	});

	test('B. TestBridge exposes both providers\' state (#90)', async function () {
		const conversation = await vscode.commands.executeCommand<ProviderState>(
			'pocketshell.__test.conversation.getState',
		);
		const promptComposer = await vscode.commands.executeCommand<ProviderState>(
			'pocketshell.__test.promptComposer.getState',
		);

		// The bridge returned SOMETHING (proves the command registered at all).
		assert.ok(
			typeof conversation === 'object' && conversation !== null,
			'pocketshell.__test.conversation.getState returned no object — the ' +
				'TestBridge did not register. The extension must run with ' +
				'process.env.POCKETSHELL_E2E === "1" (the harness sets this); ' +
				'see registerProvidersTestBridge() in extension.ts.',
		);
		assert.ok(
			typeof promptComposer === 'object' && promptComposer !== null,
			'pocketshell.__test.promptComposer.getState returned no object — the ' +
				'TestBridge did not register.',
		);

		// No error field (proves the bridge wired to a LIVE provider instance
		// and its getState() did not throw).
		assert.ok(
			!('error' in conversation),
			`conversation bridge returned an error: ${conversation.error}`,
		);
		assert.ok(
			!('error' in promptComposer),
			`promptComposer bridge returned an error: ${promptComposer.error}`,
		);

		// The snapshot carries the expected viewId — proves the bridge wires to
		// the CORRECT live instance, not a stub or the wrong provider.
		assert.strictEqual(
			conversation.viewId,
			CONVERSATION_VIEW_ID,
			`conversation bridge viewId mismatch: expected ${CONVERSATION_VIEW_ID}, ` +
				`got ${conversation.viewId}`,
		);
		assert.strictEqual(
			promptComposer.viewId,
			PROMPT_COMPOSER_VIEW_ID,
			`promptComposer bridge viewId mismatch: expected ${PROMPT_COMPOSER_VIEW_ID}, ` +
				`got ${promptComposer.viewId}`,
		);

		// The model fields are present and well-typed (proves getState returns
		// the LauncherPanelModel snapshot, not an empty object).
		assert.ok(
			typeof conversation.status === 'object' && conversation.status !== null,
			`conversation snapshot missing status object: ${JSON.stringify(conversation)}`,
		);
		assert.ok(
			typeof promptComposer.status === 'object' && promptComposer.status !== null,
			`promptComposer snapshot missing status object: ${JSON.stringify(promptComposer)}`,
		);
		assert.strictEqual(
			typeof conversation.revision,
			'number',
			`conversation revision should be a number: ${JSON.stringify(conversation)}`,
		);
		assert.strictEqual(
			typeof promptComposer.revision,
			'number',
			`promptComposer revision should be a number: ${JSON.stringify(promptComposer)}`,
		);

		console.log('[e2e-inhost#90] bridge snapshots:', {
			conversation: {
				viewId: conversation.viewId,
				resolved: conversation.resolved,
				visible: conversation.visible,
				hasConnection: conversation.hasConnection,
				status: conversation.status,
				revision: conversation.revision,
			},
			promptComposer: {
				viewId: promptComposer.viewId,
				resolved: promptComposer.resolved,
				visible: promptComposer.visible,
				hasConnection: promptComposer.hasConnection,
				status: promptComposer.status,
				revision: promptComposer.revision,
			},
		});
	});

	// Test C (attribution reflects the fixture agent session) is intentionally
	// SKIPPED. Attribution in these providers is:
	//   1. async — refreshAttribution() runs on view resolve / visibility change
	//      and delegates to `pocketshell.tmux-ui.getActivePaneConversationHint`;
	//   2. dependent on an ACTIVE tmux pane being focused/attributable — the
	//      fixture runs an agent in tmux, but no pane is deterministically
	//      focused in the E2E host, so the hint command may return undefined or
	//      'no-match' depending on host focus state;
	//   3. not directly observable in the test budget — the model only updates
	//      after the hint resolves, and a deterministic match is not guaranteed.
	// Forcing this would produce a flaky test. The marquee for #90 is tests A
	// (views open) + B (bridge wires to live instances); attribution itself is
	// a backend concern with its own unit coverage. Do NOT add test C.

	// Best-effort cleanup: close any auxiliary-bar views we may have opened so
	// the host is left tidy for subsequent suites. TDD `suiteTeardown` == BDD
	// `after`. Never throw — cleanup is best-effort.
	suiteTeardown(async function () {
		try {
			await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
			console.log('[e2e-inhost#90] suiteTeardown: closed auxiliary bar');
		} catch (err) {
			console.warn(
				'[e2e-inhost#90] suiteTeardown close failed (ignored):',
				err,
			);
		}
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
