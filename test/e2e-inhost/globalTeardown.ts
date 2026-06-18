/**
 * In-host E2E global teardown (runs in the Node runner process, AFTER the test
 * run completes or fails).
 *
 * Stops the Docker SSH fixture and removes the temp dirs created by
 * {@link globalSetup}.
 */

import * as fs from 'fs';
import { stopFixture } from './fixtures/docker-fixture';
import type { E2eContext } from './e2e-context';

/** Best-effort recursive rm. Tolerates missing paths. */
function rmrf(target: string): void {
	try {
		fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
	} catch (err) {
		console.warn(
			`[e2e-inhost] globalTeardown: failed to remove ${target}:`,
			err instanceof Error ? err.message : err,
		);
	}
}

/**
 * Stop the fixture and clean up temp dirs.
 */
export async function globalTeardown(ctx: E2eContext): Promise<void> {
	console.log('[e2e-inhost] globalTeardown: starting');

	// Debug escape hatch: keep the temp dirs (and the seeded config + exthost
	// log) for post-mortem inspection.
	if (process.env.POCKETSHELL_E2E_KEEP_DIRS === '1') {
		console.log('[e2e-inhost] globalTeardown: POCKETSHELL_E2E_KEEP_DIRS=1 — skipping tmp dir removal');
		console.log('[e2e-inhost]   userDataDir:', ctx.userDataDir);
		console.log('[e2e-inhost]   tmpHome:', ctx.tmpHome);
	} else {
		rmrf(ctx.userDataDir);
		rmrf(ctx.extensionsDir);
		rmrf(ctx.tmpHome);
		const base = process.env.POCKETSHELL_E2E_TMP_BASE;
		if (base && !process.env.POCKETSHELL_E2E_USER_DATA_DIR) {
			rmrf(base);
		}
	}

	try {
		await stopFixture();
	} catch (err) {
		console.warn(
			'[e2e-inhost] globalTeardown: stopFixture failed:',
			err instanceof Error ? err.message : err,
		);
	}

	console.log('[e2e-inhost] globalTeardown: done');
}
