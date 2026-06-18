/**
 * In-host E2E global setup (runs in the Node runner process, BEFORE
 * `@vscode/test-electron` launches the forked binary).
 *
 * Responsibilities:
 *  1. Start the Docker SSH fixture (reuses `test/e2e/helpers/docker-fixture.ts`)
 *     and wait for it to become healthy.
 *  2. Create temp dirs: `userDataDir` (--user-data-dir), `extensionsDir`
 *     (--extensions-dir), and `tmpHome` (the HOME the host sees).
 *  3. Seed `~/.ssh/config` (so the extension resolves the fixture host) and
 *     `settings.json` (so activate() reads autoConnect=true + lastHostId).
 *  4. Persist an {@link E2eContext} to `<userDataDir>/e2e-context.json` for the
 *     in-host tests to read back (they run in a separate process).
 *
 * @returns the {@link E2eContext}. Passed to `globalTeardown` by the runner.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
	startFixture,
	type FixtureInfo,
} from './fixtures/docker-fixture';
import { seedSshConfig, FIXTURE_ALIAS, FIXTURE_HOST_ID } from './fixtures/ssh-config';
import { seedAppSettings } from './fixtures/app-settings';
import { type E2eContext, CONTEXT_FILENAME } from './e2e-context';

/**
 * Resolve the temp dirs. Each can be overridden via env for debugging; otherwise
 * a fresh unique directory under `os.tmpdir()` is created.
 */
function resolveTempDirs(): { userDataDir: string; extensionsDir: string; tmpHome: string } {
	const base =
		process.env.POCKETSHELL_E2E_TMP_BASE ??
		fs.mkdtempSync(path.join(os.tmpdir(), 'pocketshell-e2e-'));

	const userDataDir = process.env.POCKETSHELL_E2E_USER_DATA_DIR ?? path.join(base, 'userData');
	const extensionsDir = process.env.POCKETSHELL_E2E_EXTENSIONS_DIR ?? path.join(base, 'extensions');
	const tmpHome = process.env.POCKETSHELL_E2E_HOME ?? path.join(base, 'home');

	fs.mkdirSync(userDataDir, { recursive: true });
	fs.mkdirSync(extensionsDir, { recursive: true });
	fs.mkdirSync(tmpHome, { recursive: true });

	return { userDataDir, extensionsDir, tmpHome };
}

/**
 * Start the fixture, create the temp dirs, seed config + settings, and persist
 * the e2e context.
 */
export async function globalSetup(): Promise<E2eContext> {
	console.log('[e2e-inhost] globalSetup: starting');

	// 1. Start the Docker SSH fixture.
	const fixture: FixtureInfo = await startFixture(60);
	console.log('[e2e-inhost] fixture healthy:', fixture);

	// 2. Temp dirs.
	const { userDataDir, extensionsDir, tmpHome } = resolveTempDirs();
	console.log('[e2e-inhost] tmp dirs:', { userDataDir, extensionsDir, tmpHome });

	// 3a. Seed ~/.ssh/config under the temp HOME.
	seedSshConfig(tmpHome, fixture.keyPath, {
		host: fixture.host,
		port: fixture.port,
		user: fixture.user,
	});

	// 3b. Seed settings.json with autoConnect=true + lastHostId=<fixture id>.
	seedAppSettings(userDataDir, FIXTURE_HOST_ID);

	// 4. Persist the context for the in-host tests.
	const ctx: E2eContext = {
		userDataDir,
		extensionsDir,
		tmpHome,
		alias: FIXTURE_ALIAS,
		hostId: FIXTURE_HOST_ID,
		fixture: {
			host: fixture.host,
			port: fixture.port,
			user: fixture.user,
			keyPath: fixture.keyPath,
		},
	};
	const contextPath = path.join(userDataDir, CONTEXT_FILENAME);
	fs.writeFileSync(contextPath, JSON.stringify(ctx, null, 2), 'utf-8');
	console.log('[e2e-inhost] context written to', contextPath);
	console.log('[e2e-inhost] expected hostId for', FIXTURE_ALIAS, '=', FIXTURE_HOST_ID);

	return ctx;
}
