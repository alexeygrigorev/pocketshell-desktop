/**
 * In-host test entry — the standard `@vscode/test-electron` Mocha pattern.
 *
 * This module is loaded inside the forked VS Code extension host (with the real
 * `vscode` module and the PocketShell extension already activated). It boots
 * Mocha and runs every `*.test.ts` in this directory.
 *
 * See: https://code.visualstudio.com/api/working-with-extensions/testing-extension
 */

import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

/**
 * Build and run the Mocha suite. Called by test-electron after the host loads
 * this module.
 */
export async function run(): Promise<void> {
	const mocha = new Mocha({
		ui: 'tdd',
		color: true,
	});

	// Locate every compiled test file next to this module. The `.mocharc.json`
	// sets the generous timeout (real SSH connections); we honor it by not
	// overriding timeout here.
	const testsRoot = __dirname;
	// glob v10: glob(pattern, options) returns a Promise<string[]> when invoked
	// without a callback.
	const files = await glob('**/*.test.js', { cwd: testsRoot });

	// Sort for deterministic ordering.
	files.sort();

	for (const f of files) {
		mocha.addFile(path.resolve(testsRoot, f));
	}

	// Run the suite. Failures cause test-electron to report a non-zero exit.
	await new Promise<void>((resolve) => {
		mocha.run((failures: number) => {
			if (failures > 0) {
				console.error(`[e2e-inhost] ${failures} test(s) failed`);
			}
			// Resolve either way; the runner's exit code comes from runTests.
			resolve();
		});
	});
}
