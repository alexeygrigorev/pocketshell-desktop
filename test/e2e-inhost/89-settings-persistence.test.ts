/**
 * E2E spec #89: dedicated PocketShell settings view / settings persistence.
 *
 * MARQUEE assertion: a setting written through the extension's LIVE
 * `SettingsStore` (via the `pocketshell.__test.settings.update` TestBridge
 * command) PERSISTS to `settings.json` on disk under globalStorage AND reads
 * back through the live instance. This is the settings WRITE PATH proven
 * end-to-end inside the real activated extension — the exact surface the #89
 * settings view is built on top of (`SettingsStore.update(partial)`).
 *
 * The full pipeline under test:
 *   TestBridge `pocketshell.__test.settings.update` (partial)
 *     → SettingsStore.update(partial)
 *       → merge with cached AppSettings
 *       → SettingsStore.save(merged)
 *         → fs.mkdirSync(dirname, { recursive: true })
 *         → fs.writeFileSync(<globalStorage>/pocketshell.pocketshell/settings.json)
 *
 * Then independently re-read the on-disk file (bypassing the store cache) to
 * assert the write actually reached disk, and finally `pocketshell.__test
 * .settings.get` to prove the live instance serves the new value.
 *
 * Field choice: we round-trip `diagnosticsMaxEvents` — a pure in-memory
 * diagnostic-event ring-buffer cap. It does NOT affect startup, auto-connect,
 * session restore, or the update check, so mutating it is safe for the other
 * in-host suites running in the same activated extension (#81, #94, #85).
 *
 * This runs IN-HOST. We drive the TestBridge via `vscode.commands` (no require
 * of the built extension tree needed — the bridge is registered when
 * `process.env.POCKETSHELL_E2E === '1'`, which the harness sets) and read the
 * disk file directly with `fs`.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

import type { E2eContext } from './e2e-context';

/** Minimal structural shape of the AppSettings snapshot the bridge returns. */
interface AppSettingsLike {
	[key: string]: unknown;
	diagnosticsMaxEvents: number;
}

/** The field this suite round-trips. Safe: does not touch startup/connection. */
const MUTATED_FIELD = 'diagnosticsMaxEvents';

/** Sentinel offset added to the baseline value so the test value is distinctive. */
const SENTINEL_OFFSET = 7;

suite('E2E #89 — settings persistence write-path', function () {
	this.timeout(60000);

	let ctx: E2eContext;
	let settingsPath: string;
	let baseline: AppSettingsLike | undefined;
	let baselineValue: number | undefined;

	suiteSetup(async function () {
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

		// Disk path asserted in this spec:
		//   <userDataDir>/User/globalStorage/pocketshell.pocketshell/settings.json
		// (matches extension.ts: storageDir = globalStorageUri.fsPath;
		//  SettingsStore(path.join(storageDir, 'settings.json'))).
		settingsPath = path.join(
			ctx.userDataDir,
			'User',
			'globalStorage',
			'pocketshell.pocketshell',
			'settings.json',
		);

		// Capture the BASELINE snapshot so suiteTeardown can restore it. The
		// get command returns the live AppSettings object; if it returns
		// undefined the TestBridge didn't register (E2E env not set on the
		// extension side) — fail loudly.
		const snapshot = await vscode.commands.executeCommand(
			'pocketshell.__test.settings.get',
		);
		assert.ok(
			typeof snapshot === 'object' && snapshot !== null,
			'pocketshell.__test.settings.get returned no object — the TestBridge ' +
				'did not register. The extension must run with ' +
				'process.env.POCKETSHELL_E2E === "1" (the harness sets this); ' +
				'see registerSettingsTestBridge() in update-controller.ts.',
		);
		baseline = snapshot as AppSettingsLike;
		baselineValue = baseline[MUTATED_FIELD] as number;
		assert.ok(
			typeof baselineValue === 'number',
			`Baseline ${MUTATED_FIELD} is not a number: ${JSON.stringify(baselineValue)}`,
		);

		console.log('[e2e-inhost#89] context:', {
			alias: ctx.alias,
			settingsPath,
			baselineValue,
		});
	});

	test('A. settings.__test.get returns the live snapshot', async function () {
		const snapshot = await vscode.commands.executeCommand<AppSettingsLike>(
			'pocketshell.__test.settings.get',
		);
		assert.ok(
			typeof snapshot === 'object' && snapshot !== null,
			'pocketshell.__test.settings.get should return an object snapshot',
		);
		// Assert it carries the expected seeded keys — proves the bridge exposes
		// the LIVE store, not a stub.
		assert.ok(
			'autoConnect' in snapshot,
			`Live snapshot missing expected key 'autoConnect'. Keys: ${Object.keys(snapshot).join(', ')}`,
		);
		assert.ok(
			MUTATED_FIELD in snapshot,
			`Live snapshot missing expected key '${MUTATED_FIELD}'. Keys: ${Object.keys(snapshot).join(', ')}`,
		);
		console.log('[e2e-inhost#89] live snapshot keys:', Object.keys(snapshot));
	});

	test('B. settings.__test.update persists to disk and reads back (#89)', async function () {
		const distinctive = baselineValue! + SENTINEL_OFFSET;

		// 1) Drive the bridge: update merges the partial into the live store and
		//    returns the new snapshot.
		const updated = await vscode.commands.executeCommand<AppSettingsLike>(
			'pocketshell.__test.settings.update',
			{ [MUTATED_FIELD]: distinctive },
		);
		assert.ok(
			typeof updated === 'object' && updated !== null,
			'pocketshell.__test.settings.update should return the new snapshot',
		);
		assert.strictEqual(
			updated[MUTATED_FIELD],
			distinctive,
			`Returned snapshot should reflect the updated ${MUTATED_FIELD}`,
		);

		// 2) MARQUEE #89: the write reached DISK via the real store. Re-read the
		//    file directly (bypassing the in-memory cache) and assert the value.
		assert.ok(
			fs.existsSync(settingsPath),
			`settings.json not found on disk at: ${settingsPath} ` +
				'(SettingsStore.save should create the file on first write).',
		);
		const onDisk = JSON.parse(
			fs.readFileSync(settingsPath, 'utf-8'),
		) as Record<string, unknown>;
		assert.strictEqual(
			onDisk[MUTATED_FIELD],
			distinctive,
			`On-disk settings.json ${MUTATED_FIELD} should equal ${distinctive} ` +
				`(the write did not reach disk). On-disk object:\n${JSON.stringify(onDisk, null, 2)}`,
		);

		// 3) Read-back through the LIVE instance: a fresh `.get` still returns
		//    the distinctive value (the cache and disk agree).
		const reread = await vscode.commands.executeCommand<AppSettingsLike>(
			'pocketshell.__test.settings.get',
		);
		assert.strictEqual(
			reread[MUTATED_FIELD],
			distinctive,
			`Live .get after update should return the distinctive value ${distinctive}`,
		);

		console.log('[e2e-inhost#89] write-path verified:', {
			baseline: baselineValue,
			distinctive,
			settingsPath,
			onDiskValue: onDisk[MUTATED_FIELD],
		});
	});

	// Best-effort cleanup: restore the baseline so other suites / future runs
	// are unaffected by the mutation above. TDD `suiteTeardown` == BDD `after`.
	// Never throw — cleanup is best-effort.
	suiteTeardown(async function () {
		try {
			if (!baseline) {
				console.warn(
					'[e2e-inhost#89] suiteTeardown: no baseline captured, skipping restore',
				);
				return;
			}
			await vscode.commands.executeCommand(
				'pocketshell.__test.settings.update',
				baseline,
			);
			console.log(
				`[e2e-inhost#89] suiteTeardown: restored baseline ${MUTATED_FIELD}=${baselineValue}`,
			);
		} catch (err) {
			console.warn(
				'[e2e-inhost#89] suiteTeardown restore failed (ignored):',
				err,
			);
		}
	});
});
