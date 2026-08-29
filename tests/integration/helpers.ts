import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe } from 'vitest';

/**
 * Shared helpers for integration tests.
 *
 * Integration tests use `testcontainers` to build the Dockerfiles under
 * tests-docker/ on an ephemeral host port. Every suite REFUSES to collect
 * when Docker is unavailable rather than skipping - a suite that cannot run
 * must be a red file, never a green tick nobody earned - so Docker must be
 * up for `npm run test:integration` (scripts/smoke.sh owns that for the
 * full gate).
 */

const DOCKER_DIR = resolve(__dirname, '..', '..', 'tests-docker');

/** Absolute path to the committed ed25519 test private key. */
export const TEST_KEY_PATH = resolve(DOCKER_DIR, 'test_key');

/** Read the test private key as a string (for privateKey injection tests). */
export function readTestKey(): string {
  return readFileSync(TEST_KEY_PATH, 'utf8');
}

/** True iff the docker CLI is present AND the daemon answers `docker info`. */
export function isDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * List every session on every tmux server this user has, as
 * `<name>::<path>` lines — the default socket AND the per-session
 * `tmuxctl-<name>` servers the helper's tmuxctl puts its creates on
 * (0.3.5+). The glob alone reaches the default socket: `default` is a
 * file in the same `tmux-<uid>/` directory as the per-session ones.
 *
 * Wrap in `pathAwareCommand`. Dead sockets print nothing (stderr is
 * dropped per iteration), which is the sweep's degrade direction
 * everywhere else in the app too — see SESSION_ENRICHMENT_COMMAND.
 */
export const LIST_SESSIONS_ANY_SOCKET =
  'for __ps_s in "${TMUX_TMPDIR:-/tmp}"/tmux-$(id -u)/*; do ' +
  '[ -S "$__ps_s" ] || continue; ' +
  "tmux -S \"$__ps_s\" list-sessions -F '#{session_name}::#{session_path}' 2>/dev/null; " +
  'done';

/**
 * `describe` wrapper that REFUSES to collect the suite when Docker is
 * unavailable. Use as the top-level describe in an integration test file:
 *
 *   describeDocker('SshService integration', () => { it(...) })
 *
 * It used to `describe.skip` instead, and a skip is a green tick the gate
 * never earned: a machine with Docker down reported a passing suite that ran
 * nothing. Throwing during collection turns the same state into a loud red
 * file - start Docker or run scripts/smoke.sh, which owns the whole gate.
 */
export function describeDocker(name: string, fn: () => void): void {
  if (!isDockerAvailable()) {
    throw new Error(
      `${name}: Docker is not reachable, so this integration suite cannot run. ` +
        'Start Docker (docker info must answer) rather than letting the suite skip.',
    );
  }
  describe(name, fn);
}

export { DOCKER_DIR };
