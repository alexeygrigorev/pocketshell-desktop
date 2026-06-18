import { execSync } from 'node:child_process';
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

/** Stop the helper compose service. */
export function stopHelper(): void {
  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" stop helper`, { stdio: 'ignore' });
  } catch {
    // best-effort
  }
}
