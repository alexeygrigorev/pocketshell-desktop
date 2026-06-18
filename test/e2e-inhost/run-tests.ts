/**
 * Node-side runner for the in-host E2E suite.
 *
 * Launches the forked PocketShell VS Code binary via `@vscode/test-electron`
 * with the built PocketShell extension active, then runs the compiled test
 * entry (`out/e2e-inhost/index.js`) inside the extension host.
 *
 * The exact launch configuration was pinned by a prior spike (5 failed
 * launches). The load-bearing incantations are called out inline; do NOT
 * reorder or drop them.
 *
 * Run via: `npm run test:e2e:inhost` (which compiles, then wraps in xvfb).
 */

import * as path from 'path';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

import { globalSetup } from './globalSetup';
import { globalTeardown } from './globalTeardown';
import { CONTEXT_FILENAME } from './e2e-context';

// --- Spike-validated constants ------------------------------------------------

/** Absolute path to the vendored VS Code fork root. */
const VSCODE_ROOT = '/home/alexey/git/pocketshell-desktop/vendor/vscode';

/** The forked binary. Built by `scripts/build-base.sh`. */
const VSCODE_EXECUTABLE_PATH = path.join(VSCODE_ROOT, '.build', 'electron', 'pocketshell');

/**
 * The BUILT extension dir (NOT the source). `extensionDevelopmentPath` must
 * point at the compiled `out/extension.js` + `package.json` tree.
 */
const EXTENSION_DEVELOPMENT_PATH = path.join(
	VSCODE_ROOT,
	'.build',
	'extensions',
	'pocketshell',
);

/** Compiled test entry (the standard test-electron Mocha module). */
const EXTENSION_TESTS_PATH = path.resolve(__dirname, 'index.js');

// -----------------------------------------------------------------------------

/**
 * Fail fast with a clear message if the forked binary is missing.
 */
function assertBinaryPresent(): void {
	if (!fs.existsSync(VSCODE_EXECUTABLE_PATH)) {
		console.error(
			`[e2e-inhost] Forked binary not found at ${VSCODE_EXECUTABLE_PATH}\n` +
				'[e2e-inhost] Run `bash scripts/build-base.sh` first to build the vendor binary.',
		);
		process.exit(1);
	}
	if (!fs.existsSync(path.join(EXTENSION_DEVELOPMENT_PATH, 'package.json'))) {
		console.error(
			`[e2e-inhost] Built extension not found at ${EXTENSION_DEVELOPMENT_PATH}\n` +
				'[e2e-inhost] Rebuild the extension (e.g. `bash scripts/build.sh`).',
		);
		process.exit(1);
	}
}

async function main(): Promise<void> {
	assertBinaryPresent();

	// --- The 3 mandatory incantations (Node side), before runTests -------------

	// (env) dev flags the fork needs to resolve resources and not hit update paths
	process.env.NODE_ENV = 'development';
	process.env.VSCODE_DEV = '1';
	process.env.VSCODE_CLI = '1';
	process.env.ELECTRON_ENABLE_LOGGING = '1';

	// (1) The fork has no resources/app; the Electron app resolves its resource
	//     root from the current working directory, so chdir to VSCODE_ROOT.
	process.chdir(VSCODE_ROOT);

	// Reserved for Phase B's TestBridge (harmless now).
	process.env.POCKETSHELL_E2E = '1';

	// --- globalSetup: start fixture, create tmp dirs, seed config/settings -----
	const ctx = await globalSetup();

	// The host process must see the seeded ~/.ssh/config. os.homedir() honors
	// HOME on POSIX, so pointing HOME at our temp home makes the extension read
	// the seeded config.
	process.env.HOME = ctx.tmpHome;

	// Surface the context JSON path to the in-host tests. test-electron forks
	// the host as a child process inheriting this env, so the value survives.
	process.env.POCKETSHELL_E2E_CONTEXT = path.join(ctx.userDataDir, CONTEXT_FILENAME);

	try {
		// (2) The FIRST launchArg MUST be the workspace path (positional, = form
		//     for flags). (3) extensionDevelopmentPath MUST be the BUILT ext dir.
		//
		// Note: test-electron v3 auto-adds --no-sandbox, --disable-gpu-sandbox,
		// --disable-updates, --skip-welcome, --skip-release-notes,
		// --no-cached-data, and --extensionTestsPath=<...>. Do NOT add those.
		const exitCode = await runTests({
			vscodeExecutablePath: VSCODE_EXECUTABLE_PATH,
			extensionDevelopmentPath: EXTENSION_DEVELOPMENT_PATH,
			extensionTestsPath: EXTENSION_TESTS_PATH,
			launchArgs: [
				VSCODE_ROOT, // FIRST, positional — required workspace path
				`--user-data-dir=${ctx.userDataDir}`,
				`--extensions-dir=${ctx.extensionsDir}`,
				'--disable-workspace-trust',
				'--disable-gpu',
			],
		});

		console.log(`[e2e-inhost] runTests exited with code ${exitCode}`);
		process.exitCode = exitCode;
	} finally {
		await globalTeardown(ctx);
	}
}

main().catch((err) => {
	console.error('[e2e-inhost] runner failed:', err);
	process.exitCode = 1;
});
