import { execFileSync, execSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * E2E helpers: bring up the Docker `helper` container on the fixed compose
 * port (3205) and seed a disposable ssh-config entry pointing at it, so the
 * app's host picker lists a host that connects to the deterministic fixture.
 *
 * The Playwright test launches the real Electron app, which reads this
 * seeded config and connects to localhost:3205 with the committed test_key.
 */

export const HOST_PORT = 3205;
export const E2E_HOST_NAME = 'pocketshell-test';
export const PROJECT_ROOT = resolve(__dirname, '..', '..');
export const COMPOSE_FILE = resolve(PROJECT_ROOT, 'tests-docker', 'docker-compose.yml');
export const TEST_KEY = resolve(PROJECT_ROOT, 'tests-docker', 'test_key');

/** True iff the helper container is reachable on the fixed port. */
export function isHelperUp(): boolean {
  try {
    execSync(
      `ssh -i "${TEST_KEY}" -p ${HOST_PORT} -o BatchMode=yes -o ConnectTimeout=2 ` +
        `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null testuser@127.0.0.1 true`,
      { stdio: 'ignore', timeout: 5_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Start the helper compose service (idempotent). Throws if it won't come up. */
export function ensureHelperUp(deadlineMs = 60_000): void {
  if (isHelperUp()) return;
  execSync(`docker compose -f "${COMPOSE_FILE}" up -d --build --wait helper`, {
    stdio: 'inherit',
    timeout: deadlineMs,
  });
  const start = Date.now();
  while (!isHelperUp() && Date.now() - start < deadlineMs) {
    execSync('sleep 1', { stdio: 'ignore' });
  }
  if (!isHelperUp()) throw new Error('helper container did not become reachable');
}

/**
 * Seed the project folders the folder-first session tests browse and clone
 * from: `~/git/demo-repo` (a plain `git init`, so `full_name` is null and the
 * merge must fall back to `name`) and `~/git/Hello-World` (a GitHub origin, so
 * it merges as `octocat/Hello-World`).
 *
 * Idempotent and run per spec, deliberately: the helper IMAGE ships no `~/git`
 * at all, and `ensureHelperUp` recreates the container whenever the image
 * changes — so anything a previous run created is not something a later run
 * may assume.
 */
export function seedProjectFolders(): void {
  execInFixture([
    'set -e',
    'mkdir -p "$HOME/git/demo-repo" "$HOME/git/Hello-World"',
    'cd "$HOME/git/demo-repo" && git init -q .',
    'cd "$HOME/git/Hello-World" && git init -q .',
    'cd "$HOME/git/Hello-World" && (git remote add origin ' +
      'https://github.com/octocat/Hello-World.git || true)',
  ]);
}

/**
 * Run a `sh -lc` script inside the helper container as `testuser`.
 *
 * `execFileSync` with an argv array, NOT `execSync` with a command string: on
 * Windows `execSync` goes through cmd.exe, where single quotes are ordinary
 * characters, so a quoted shell script arrives at `sh -lc` in pieces.
 */
export function execInFixture(lines: string[]): void {
  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      COMPOSE_FILE,
      'exec',
      '-T',
      '-u',
      'testuser',
      'helper',
      'sh',
      '-lc',
      lines.join('\n'),
    ],
    { stdio: 'ignore', timeout: 30_000 },
  );
}

/** Stop the helper compose service. */
export function stopHelper(): void {
  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" stop helper`, { stdio: 'ignore' });
  } catch {
    // best-effort
  }
}
