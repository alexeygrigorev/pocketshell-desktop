import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe } from 'vitest';

/**
 * Shared helpers for integration tests.
 *
 * Integration tests use `testcontainers` to build the Dockerfiles under
 * tests-docker/ on an ephemeral host port. Every suite auto-skips when
 * Docker is unavailable (matching the Android project's `assumeTrue`),
 * so the unit suite stays green on machines without Docker.
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
 * `describe` wrapper that skips the whole suite when Docker is unavailable.
 * Use as the top-level describe in an integration test file:
 *
 *   describeDocker('SshService integration', () => { it(...) })
 */
export const describeDocker = isDockerAvailable() ? describe : describe.skip;

export { DOCKER_DIR };
