import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const COMPOSE_FILE = path.join(PROJECT_ROOT, 'test/fixtures/docker/docker-compose.yml');
const WAIT_SCRIPT = path.join(PROJECT_ROOT, 'test/fixtures/docker/lib/wait-for-healthy.sh');
const KEY_PATH = path.join(PROJECT_ROOT, 'test/fixtures/docker/test_key');

/** Fixture connection details returned after starting the container. */
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
 * Start the Docker SSH fixture container.
 * Runs `docker compose up -d --build` and waits for the healthcheck to pass.
 */
export async function startFixture(timeout = 60): Promise<FixtureInfo> {
  console.log('Starting Docker SSH fixture...');
  await execFileAsync('docker', [
    'compose',
    '-f', COMPOSE_FILE,
    'up', '-d', '--build',
  ], { cwd: PROJECT_ROOT, timeout: 120_000 });

  // Determine the container name. docker compose v2 uses project-dir-prefixed names.
  const containerName = await getContainerName();

  console.log(`Waiting for container ${containerName} to become healthy...`);
  await execFileAsync('bash', [WAIT_SCRIPT, containerName, String(timeout)], {
    cwd: PROJECT_ROOT,
    timeout: (timeout + 10) * 1000,
  });

  return DEFAULT_FIXTURE;
}

/**
 * Stop and remove the Docker SSH fixture container.
 */
export async function stopFixture(): Promise<void> {
  console.log('Stopping Docker SSH fixture...');
  await execFileAsync('docker', [
    'compose',
    '-f', COMPOSE_FILE,
    'down', '-v',
  ], { cwd: PROJECT_ROOT, timeout: 60_000 });
}

/**
 * Check whether the Docker SSH fixture container is running and healthy.
 */
export async function isFixtureRunning(): Promise<boolean> {
  try {
    const containerName = await getContainerName();
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '--format={{.State.Health.Status}}',
      containerName,
    ]);
    return stdout.trim() === 'healthy';
  } catch {
    return false;
  }
}

/**
 * Resolve the Docker container name for the fixture.
 * Tries the standard compose v2 naming convention.
 */
async function getContainerName(): Promise<string> {
  // docker compose v2 uses "<project>-<service>-<number>"
  // Project name defaults to the directory name: "docker"
  const candidates = [
    'pocketshell-desktop-agents-1',
    'docker-agents-1',
  ];

  for (const name of candidates) {
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        '--format={{.Name}}',
        name,
      ]);
      if (stdout.trim()) return name;
    } catch {
      // try next
    }
  }

  // Fallback: use docker compose ps to discover the name
  try {
    const { stdout } = await execFileAsync('docker', [
      'compose',
      '-f', COMPOSE_FILE,
      'ps', '-q',
    ], { cwd: PROJECT_ROOT });

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

  // Last resort
  return 'pocketshell-desktop-agents-1';
}
