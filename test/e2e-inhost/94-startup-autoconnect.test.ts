/**
 * E2E spec #94: startup auto-connect.
 *
 * MARQUEE assertion: the seeded `autoConnect: true` + `lastHostId` caused the
 * extension to ACTUALLY auto-connect to the Docker fixture at launch.
 *
 * This runs IN-HOST (the real forked VS Code, the real activated extension).
 * By the time this suite runs, `activate()` has already fired — including the
 * fire-and-forget `connector.run(appSettings)` (see `extension.ts:933`) which,
 * for a `connect` action, invokes `pocketshell.surface.connect` → the real SSH
 * pipeline to the fixture.
 *
 * The full pipeline under test:
 *   activate()
 *     → SettingsStore.load() reads autoConnect=true + lastHostId=<fixture id>
 *     → StartupAutoConnector.run()
 *       → decideStartupAction() → { kind: 'connect', hostId }
 *       → vscode.commands 'pocketshell.surface.connect' <hostId>
 *         → ConnectionService.connect(hostId) → real SSH to localhost:2222
 *
 * We do NOT drive `vscode.window.showQuickPick` (it blocks the host UI); the
 * pick/noop dispatch is already covered by the unit suite. This spec proves the
 * real end-to-end auto-connect path only.
 *
 * ConnectionService import: this module is compiled under
 * `out/e2e-inhost/`, NOT inside the extension's `out/` tree, so the bare
 * `'pocketshell/...'` alias does not resolve. We require the singleton from the
 * BUILT extension via its absolute path at runtime. (The built `out/` is on the
 * extension host module path once the extension activates, but an explicit
 * absolute require is unambiguous and survives module-resolution quirks.)
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import type { E2eContext } from './e2e-context';

/** Absolute path to the BUILT extension root (matches the runner constant). */
const EXTENSION_OUT = '/home/alexey/git/pocketshell-desktop/vendor/vscode/.build/extensions/pocketshell/out';

// Minimal structural type for the ConnectionService singleton surface this
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
interface ConnectionServiceCtor {
	getInstance(): ConnectionServiceLike;
}
interface ConnectionServiceLike {
	getHosts(): Promise<HostLike[]>;
	getConnection(hostId: number): unknown;
	getState(hostId: number): string;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ConnectionService } = require(path.join(EXTENSION_OUT, 'connection-service')) as {
	ConnectionService: ConnectionServiceCtor;
};

suite('E2E #94 — startup auto-connect', function () {
	this.timeout(60000);

	let ctx: E2eContext;
	let service: ConnectionServiceLike;

	suiteSetup(function () {
		service = ConnectionService.getInstance();
		// The runner set POCKETSHELL_E2E_CONTEXT to <userDataDir>/e2e-context.json
		// before forking the host; test-electron forwards process.env.
		const contextPath = process.env.POCKETSHELL_E2E_CONTEXT;
		assert.ok(
			contextPath && fs.existsSync(contextPath),
			`POCKETSHELL_E2E_CONTEXT not set or missing: ${contextPath}`,
		);
		ctx = JSON.parse(fs.readFileSync(contextPath!, 'utf-8'));
		console.log('[e2e-inhost#94] context:', {
			alias: ctx.alias,
			hostId: ctx.hostId,
			fixture: ctx.fixture,
			tmpHome: ctx.tmpHome,
		});
	});

	test('A. the seeded fixture host is present in service.getHosts()', async function () {
		const hosts = await service.getHosts();
		const match = hosts.find((h) => h.id === ctx.hostId);
		assert.ok(
			match,
			`Host id=${ctx.hostId} (alias ${ctx.alias}) not found in getHosts(). ` +
				`Hosts seen: ${JSON.stringify(hosts.map((h) => ({ id: h.id, name: h.name })))}. ` +
				`This means ~/.ssh/config seeding or parsing failed.`,
		);
		assert.strictEqual(
			match!.name,
			ctx.alias,
			`Host name mismatch: expected ${ctx.alias}, got ${match!.name}`,
		);
		console.log('[e2e-inhost#94] host present:', {
			id: match!.id,
			name: match!.name,
			hostname: match!.hostname,
			port: match!.port,
			username: match!.username,
		});
	});

	test('B. an auto-connect connection for the fixture host is active', async function () {
		// Auto-connect is fire-and-forget at activate(); the SSH handshake is
		// async, so poll getConnection() until it reports an active connection
		// (or fail after the budget).
		const deadlineMs = 15_000;
		const startedAt = Date.now();
		let conn = service.getConnection(ctx.hostId);

		while (!conn && Date.now() - startedAt < deadlineMs) {
			await sleep(250);
			conn = service.getConnection(ctx.hostId);
		}

		assert.ok(
			conn,
			`No active connection for hostId=${ctx.hostId} (${ctx.alias}) within ${deadlineMs}ms. ` +
				`Auto-connect did not establish a real SSH connection to the fixture. ` +
				`Check <userDataDir>/logs/.../exthost/exthost.log for the connect path.`,
		);
		console.log(
			'[e2e-inhost#94] auto-connect connection active after',
			`${Date.now() - startedAt}ms`,
		);

		// Sanity: the state machine agrees the host is connected.
		const state = service.getState(ctx.hostId);
		assert.strictEqual(
			state,
			'Connected',
			`Expected ConnectionState 'Connected', got '${state}'`,
		);
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
