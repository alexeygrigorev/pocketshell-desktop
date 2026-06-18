/**
 * Docker SSH fixture orchestrator for the in-host E2E suite.
 *
 * This mirrors the API of `test/e2e/helpers/docker-fixture.ts`
 * (`startFixture` / `stopFixture` / `FixtureInfo` / `DEFAULT_FIXTURE`) but is
 * duplicated here because the original helper is under `test/e2e/` (off-limits
 * to edit per the task constraints). REPO_ROOT is resolved relative to
 * __dirname (see below); the depth is identical for the source (.ts) and
 * compiled (.js) locations, so a single relative expression covers both.
 *
 * The fixture is `localhost:2222`, user `testuser`, key
 * `test/fixtures/docker/test_key`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Repo root. This file lives at <repo>/test/e2e-inhost/fixtures/ (source) and
 * compiles to <repo>/out/e2e-inhost/fixtures/ — three levels below the repo
 * root in BOTH cases (fixtures → e2e-inhost → {test|out} → repo root), so
 * __dirname-based resolution is correct for both source and compiled runs.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'test/fixtures/docker/docker-compose.yml');
const WAIT_SCRIPT = path.join(REPO_ROOT, 'test/fixtures/docker/lib/wait-for-healthy.sh');
const KEY_PATH = path.join(REPO_ROOT, 'test/fixtures/docker/test_key');

/** Fixture connection details. */
export interface FixtureInfo {
	host: string;
	port: number;
	user: string;
	keyPath: string;
}

/** Default connection info for the Docker SSH fixture. */
export const DEFAULT_FIXTURE: FixtureInfo = {
	host: 'localhost',
	port: 2222,
	user: 'testuser',
	keyPath: KEY_PATH,
};

/**
 * Start the Docker SSH fixture: `docker compose up -d --build` then wait for the
 * healthcheck. compose is run from REPO_ROOT so the project name (and thus the
 * container name `docker-agents-1`) matches the original helper.
 */
export async function startFixture(timeout = 60): Promise<FixtureInfo> {
	console.log('[e2e-inhost] Starting Docker SSH fixture...');
	await execFileAsync(
		'docker',
		['compose', '-f', COMPOSE_FILE, 'up', '-d', '--build'],
		{ cwd: REPO_ROOT, timeout: 120_000 },
	);

	const containerName = await getContainerName();
	console.log(`[e2e-inhost] Waiting for container ${containerName} to become healthy...`);
	await execFileAsync('bash', [WAIT_SCRIPT, containerName, String(timeout)], {
		cwd: REPO_ROOT,
		timeout: (timeout + 10) * 1000,
	});

	return DEFAULT_FIXTURE;
}

/** Stop and remove the Docker SSH fixture (`docker compose down -v`). */
export async function stopFixture(): Promise<void> {
	console.log('[e2e-inhost] Stopping Docker SSH fixture...');
	await execFileAsync(
		'docker',
		['compose', '-f', COMPOSE_FILE, 'down', '-v'],
		{ cwd: REPO_ROOT, timeout: 60_000 },
	);
}

/**
 * Resolve the fixture container name. Tries the compose-v2 candidate names,
 * then falls back to `docker compose ps`. A candidate counts only if the
 * container is actually RUNNING (the original helper inspected for a name only,
 * which falsely matches exited/leftover containers with the same name).
 */
async function getContainerName(): Promise<string> {
	const candidates = ['pocketshell-desktop-agents-1', 'docker-agents-1'];
	for (const name of candidates) {
		try {
			const { stdout } = await execFileAsync('docker', [
				'inspect',
				'--format={{.State.Running}}',
				name,
			]);
			if (stdout.trim() === 'true') {
				return name;
			}
		} catch {
			// try next
		}
	}

	// Fallback: discover via compose ps (the just-started service).
	try {
		const { stdout } = await execFileAsync(
			'docker',
			['compose', '-f', COMPOSE_FILE, 'ps', '-q'],
			{ cwd: REPO_ROOT },
		);
		const containerId = stdout.trim().split('\n')[0];
		if (containerId) {
			const { stdout: nameOut } = await execFileAsync('docker', [
				'inspect',
				'--format={{.Name}}',
				containerId,
			]);
			return nameOut.trim().replace(/^\//, '');
		}
	} catch {
		// fall through
	}
	return 'docker-agents-1';
}
