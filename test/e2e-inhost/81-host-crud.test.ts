/**
 * E2E spec #81 / #91: ~/.ssh/config is the single source of truth for hosts.
 *
 * #81: `ConnectionService.addHost(host)` appends a `Host <alias>` stanza to
 *      `os.homedir()/.ssh/config` (via `fs.appendFileSync`), and `getHosts()`
 *      live-parses that config — so the new host appears immediately with no
 *      separate store. This spec PROVES that end-to-end inside the real
 *      activated extension: addHost mutates the on-disk config, and the very
 *      next `getHosts()` reflects it.
 *
 * #91: `ConnectionService.deleteHost(id)` resolves the alias for the id and
 *      removes the matching stanza from the config. This spec PROVES the
 *      stanza is gone from the file (not just from the parsed metadata) and
 *      that `deleteHost` returns true only because it actually removed it.
 *
 * This runs IN-HOST (the real forked VS Code, the real activated extension).
 * By the time this suite runs, the E2E globalSetup has already seeded
 * `~/.ssh/config` (under the temp HOME) with one Host stanza for the Docker
 * fixture alias.
 *
 * We mirror the 94 spec's setup: read POCKETSHELL_E2E_CONTEXT (the temp HOME,
 * the seeded alias, and fixture connection details) and POCKETSHELL_E2E_EXT_OUT
 * (the built extension out/ dir), then require the ConnectionService singleton
 * from the built tree and exercise the real addHost/getHosts/deleteHost.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import type { E2eContext } from './e2e-context';

// Minimal structural types for the ConnectionService singleton surface this
// spec exercises. We import the real instance at runtime from the BUILT
// extension via an absolute require (this module lives outside the extension's
// out/ tree, so the bare 'pocketshell/...' alias does not resolve). addHost's
// param is typed loosely here; the object we pass is constructed to satisfy
// the real NewHost shape (see addHost payload in test B).
interface HostLike {
	id: number;
	name: string;
}
interface ConnectionServiceCtor {
	getInstance(): ConnectionServiceLike;
}
interface ConnectionServiceLike {
	getHosts(): Promise<HostLike[]>;
	addHost(host: Record<string, unknown>): Promise<number>;
	deleteHost(id: number): Promise<boolean>;
}

/** Distinct alias for the host this suite adds (never collides with the seeded fixture alias). */
const ALIAS2 = 'psh-fixture-2';

suite('E2E #81 — host CRUD via ~/.ssh/config', function () {
	this.timeout(60000);

	let ctx: E2eContext;
	let service: ConnectionServiceLike;
	let configPath: string;
	// Host id returned by addHost in test B; consumed by test C. Reset in
	// suiteTeardown so a cleanup of a stale/failed addHost is safe.
	let addedId: number | undefined;

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
		// ~/.ssh/config lives under the temp HOME the runner created.
		configPath = path.join(ctx.tmpHome, '.ssh', 'config');
		console.log('[e2e-inhost#81] context:', {
			alias: ctx.alias,
			tmpHome: ctx.tmpHome,
			configPath,
			fixture: ctx.fixture,
		});
	});

	// Best-effort cleanup runs ONCE at suite end (suiteTeardown), NOT per-test:
	// test C legitimately depends on the host test B added, so a per-test hook
	// would delete the host C needs before C runs. suiteTeardown still
	// guarantees the seeded config is clean for the OTHER in-host suites even
	// if a test here fails mid-way.
	// (Mocha TDD ui: `suiteTeardown` == BDD `after`.)
	suiteTeardown(async function () {
		try {
			const hosts = await service.getHosts();
			const stale = hosts.find((h) => h.name === ALIAS2);
			if (stale) {
				console.warn(
					`[e2e-inhost#81] suiteTeardown: cleaning up leftover host "${ALIAS2}" (id=${stale.id})`,
				);
				await service.deleteHost(stale.id);
			}
		} catch (err) {
			console.warn('[e2e-inhost#81] suiteTeardown cleanup failed (ignored):', err);
		}
		addedId = undefined;
	});

	test('A. seeded fixture host is present in service.getHosts() and ~/.ssh/config', async function () {
		const hosts = await service.getHosts();
		const match = hosts.find((h) => h.name === ctx.alias);
		assert.ok(
			match,
			`Seeded host alias "${ctx.alias}" not found in getHosts(). ` +
				`Hosts seen: ${JSON.stringify(hosts.map((h) => ({ id: h.id, name: h.name })))}.`,
		);

		const configText = fs.readFileSync(configPath, 'utf-8');
		assert.ok(
			configText.includes(`Host ${ctx.alias}`),
			`~/.ssh/config does not contain a "Host ${ctx.alias}" stanza. Config:\n${configText}`,
		);
		console.log('[e2e-inhost#81] seeded host present:', {
			id: match!.id,
			name: match!.name,
		});
	});

	test('B. addHost appends a new stanza to ~/.ssh/config and it is listed (#81)', async function () {
		// Construct a NewHost-shaped payload. The real NewHost (see
		// backend/ssh/data/host-store.ts) requires exactly: name, hostname,
		// port, username, keyPath, maxAutoPort, skipPortsBelow, scanIntervalSec,
		// enabled. We point it at the Docker fixture so the stanza is real, but
		// this test only cares that the stanza lands in the config and is parsed.
		const newHost = {
			name: ALIAS2,
			hostname: ctx.fixture.host,
			port: ctx.fixture.port,
			username: ctx.fixture.user,
			keyPath: ctx.fixture.keyPath,
			maxAutoPort: 0,
			skipPortsBelow: 0,
			scanIntervalSec: 30,
			enabled: true,
		};

		const id = await service.addHost(newHost);
		assert.ok(
			typeof id === 'number' && id > 0,
			`addHost should return a positive stable id, got: ${JSON.stringify(id)}`,
		);
		addedId = id;

		// The very next live parse must include the host we just appended.
		const hosts = await service.getHosts();
		const match = hosts.find((h) => h.name === ALIAS2);
		assert.ok(
			match,
			`Host "${ALIAS2}" not found in getHosts() after addHost. ` +
				`Hosts seen: ${JSON.stringify(hosts.map((h) => ({ id: h.id, name: h.name })))}.`,
		);
		assert.strictEqual(match!.id, id, `Host id mismatch after addHost`);

		// MARQUEE #81: addHost mutated the on-disk config (appended a stanza).
		const configText = fs.readFileSync(configPath, 'utf-8');
		assert.ok(
			configText.includes(`Host ${ALIAS2}`),
			`~/.ssh/config does not contain the appended "Host ${ALIAS2}" stanza. Config:\n${configText}`,
		);
		console.log('[e2e-inhost#81] addHost appended stanza, id=', id);
	});

	test('C. deleteHost removes the stanza from ~/.ssh/config (#91)', async function () {
		// Ensure the host from test B exists (defensive: test ordering within a
		// suite is sequential in Mocha, but don't hard-fail if it's somehow gone).
		let id = addedId;
		if (!id) {
			const hosts = await service.getHosts();
			const existing = hosts.find((h) => h.name === ALIAS2);
			assert.ok(existing, `Precondition failed: host "${ALIAS2}" should exist before deleteHost`);
			id = existing!.id;
		}

		const removed = await service.deleteHost(id!);
		assert.strictEqual(
			removed,
			true,
			`deleteHost should return true when it removes the stanza, got: ${JSON.stringify(removed)}`,
		);
		addedId = undefined;

		// Live parse must no longer list the host.
		const hosts = await service.getHosts();
		const stillThere = hosts.find((h) => h.name === ALIAS2);
		assert.ok(
			!stillThere,
			`Host "${ALIAS2}" still present in getHosts() after deleteHost. ` +
				`Hosts seen: ${JSON.stringify(hosts.map((h) => ({ id: h.id, name: h.name })))}.`,
		);

		// MARQUEE #91: the stanza is gone from the on-disk config (not just the
		// parsed metadata view).
		const configText = fs.readFileSync(configPath, 'utf-8');
		assert.ok(
			!configText.includes(`Host ${ALIAS2}`),
			`~/.ssh/config still contains a "Host ${ALIAS2}" stanza after deleteHost. Config:\n${configText}`,
		);
		console.log('[e2e-inhost#81] deleteHost removed stanza for id=', id);
	});
});
