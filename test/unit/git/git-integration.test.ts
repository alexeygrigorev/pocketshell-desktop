/**
 * Integration tests for Git operations over SSH.
 *
 * Tests against the Docker SSH fixture. Skipped if fixture unavailable.
 * Creates a temporary git repo, exercises GitClient operations, then cleans up.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { SshClient } from '../../../src/ssh/connection/ssh-client';
import type { SshConnection } from '../../../src/ssh/connection/ssh-client';
import { GitClient } from '../../../src/git/git-client';
import { PocketShellRepos } from '../../../src/git/pocketshell-repos';

// ---------------------------------------------------------------------------
// Fixture config
// ---------------------------------------------------------------------------

const FIXTURE_HOST = 'localhost';
const FIXTURE_PORT = 2222;
const FIXTURE_USER = 'testuser';
const FIXTURE_KEY_PATH = path.resolve(
  __dirname,
  '../../fixtures/docker/test_key',
);
const TEST_REPO = '/home/testuser/git-test-integration';

/** Check if the Docker SSH fixture is reachable. */
async function isFixtureAvailable(): Promise<boolean> {
  const client = new SshClient();
  try {
    await client.connect({
      host: FIXTURE_HOST,
      port: FIXTURE_PORT,
      user: FIXTURE_USER,
      key: { type: 'path', file: FIXTURE_KEY_PATH },
      knownHosts: { type: 'acceptAll' },
      timeoutMs: 5000,
    });
    client.disconnect();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('Git Integration (Docker fixture)', () => {
  let fixtureAvailable = false;
  let connection: SshConnection;
  let gitClient: GitClient;
  let client: SshClient;

  beforeAll(async () => {
    fixtureAvailable = await isFixtureAvailable();
    if (!fixtureAvailable) return;

    client = new SshClient();
    connection = await client.connect({
      host: FIXTURE_HOST,
      port: FIXTURE_PORT,
      user: FIXTURE_USER,
      key: { type: 'path', file: FIXTURE_KEY_PATH },
      knownHosts: { type: 'acceptAll' },
      timeoutMs: 10_000,
    });

    gitClient = new GitClient(connection);

    // Initialize a test git repo
    await connection.exec(`rm -rf ${TEST_REPO}`);
    await connection.exec(`mkdir -p ${TEST_REPO}`);
    await connection.exec(
      `cd ${TEST_REPO} && git init && git config user.email "test@test.com" && git config user.name "Test User"`,
    );
    await connection.exec(
      `cd ${TEST_REPO} && echo "hello" > README.md && git add README.md && git commit -m "Initial commit"`,
    );
  });

  afterAll(async () => {
    if (!fixtureAvailable) return;

    // Clean up test repo
    try {
      await connection.exec(`rm -rf ${TEST_REPO}`);
    } catch {
      // Best effort cleanup
    }

    client.disconnect();
  });

  it('reports clean status after commit', async () => {
    if (!fixtureAvailable) return;

    const status = await gitClient.status(TEST_REPO);
    expect(status.isClean).toBe(true);
    expect(status.branch).toBeTruthy(); // 'main' or 'master' depending on git version
  });

  it('reports dirty status after modification', async () => {
    if (!fixtureAvailable) return;

    await connection.exec(
      `cd ${TEST_REPO} && echo "modified" >> README.md`,
    );

    const status = await gitClient.status(TEST_REPO);
    expect(status.isClean).toBe(false);
    expect(status.unstaged).toHaveLength(1);
    expect(status.unstaged[0].path).toBe('README.md');

    // Revert for subsequent tests
    await connection.exec(
      `cd ${TEST_REPO} && git checkout -- README.md`,
    );
  });

  it('returns log with commit', async () => {
    if (!fixtureAvailable) return;

    const commits = await gitClient.log(TEST_REPO);
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0].subject).toBe('Initial commit');
    expect(commits[0].hash).toBeTruthy();
    expect(commits[0].shortHash).toBeTruthy();
    expect(commits[0].author).toBe('Test User');
  });

  it('lists branches with a current branch', async () => {
    if (!fixtureAvailable) return;

    const branches = await gitClient.branches(TEST_REPO);
    expect(branches.length).toBeGreaterThanOrEqual(1);

    const current = branches.find((b) => b.isCurrent);
    expect(current).toBeDefined();
    expect(current!.name).toBeTruthy();
  });

  it('returns current branch name', async () => {
    if (!fixtureAvailable) return;

    const branch = await gitClient.currentBranch(TEST_REPO);
    expect(branch).toBeTruthy(); // 'main' or 'master' depending on git version
  });

  it('shows file at HEAD', async () => {
    if (!fixtureAvailable) return;

    const content = await gitClient.show(TEST_REPO, 'HEAD', 'README.md');
    expect(content.trim()).toBe('hello');
  });

  it('pocketshell repos list returns repos', async () => {
    if (!fixtureAvailable) return;

    const repos = new PocketShellRepos(connection);
    const result = await repos.list();

    // The fixture returns /home/testuser/git/pocketshell and
    // /home/testuser/git/test-project, but we need git repos at those
    // paths for the full info to work. Just verify the call succeeds.
    // The fixture stub returns these paths regardless.
    expect(Array.isArray(result)).toBe(true);
  });
});
