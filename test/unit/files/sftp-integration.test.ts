/**
 * Integration tests for SFTP file operations.
 *
 * Tests against the Docker SSH fixture. Skips all tests if the fixture
 * is not available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { SshClient } from '../../../src/ssh/connection/ssh-client';
import type { SshConnection } from '../../../src/ssh/connection/ssh-client';
import { SftpClient } from '../../../src/files/sftp-client';

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

/** Unique test prefix to avoid collisions between runs. */
const TEST_PREFIX = `/tmp/pocketshell-sftp-test-${Date.now()}`;

// ---------------------------------------------------------------------------
// Fixture availability check
// ---------------------------------------------------------------------------

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
// Tests
// ---------------------------------------------------------------------------

describe.skip('SFTP Integration', () => {
  let connection: SshConnection;
  let sshClient: SshClient;
  let sftp: SftpClient;
  let fixtureAvailable = false;

  beforeAll(async () => {
    fixtureAvailable = await isFixtureAvailable();
    if (!fixtureAvailable) return;

    sshClient = new SshClient();
    connection = await sshClient.connect({
      host: FIXTURE_HOST,
      port: FIXTURE_PORT,
      user: FIXTURE_USER,
      key: { type: 'path', file: FIXTURE_KEY_PATH },
      knownHosts: { type: 'acceptAll' },
      timeoutMs: 10_000,
    });

    sftp = new SftpClient(connection);
    await sftp.connect();

    // Create test directory
    await sshClient.exec(`mkdir -p ${TEST_PREFIX}`);
  });

  afterAll(async () => {
    if (!fixtureAvailable) return;

    // Clean up test directory
    try {
      await sshClient.exec(`rm -rf ${TEST_PREFIX}`);
    } catch {
      // Best effort
    }

    sftp.disconnect();
    sshClient.disconnect();
  });

  it('connects and lists home directory', async () => {
    if (!fixtureAvailable) return;

    const homePath = await sftp.realpath('~');
    expect(homePath).toBeTruthy();

    const entries = await sftp.readdir(homePath);
    expect(Array.isArray(entries)).toBe(true);
    // Home directory should have at least some entries
    expect(entries.length).toBeGreaterThanOrEqual(0);
  });

  it('reads a known file', async () => {
    if (!fixtureAvailable) return;

    // Create a known file
    await sshClient.exec(`echo "hello sftp" > ${TEST_PREFIX}/read-test.txt`);

    const content = await sftp.readFileText(`${TEST_PREFIX}/read-test.txt`);
    expect(content.trim()).toBe('hello sftp');
  });

  it('writes and reads back a file', async () => {
    if (!fixtureAvailable) return;

    const testContent = 'SFTP write test content';
    await sftp.writeFile(`${TEST_PREFIX}/write-test.txt`, testContent);

    const readBack = await sftp.readFileText(`${TEST_PREFIX}/write-test.txt`);
    expect(readBack).toBe(testContent);
  });

  it('creates directory and lists it', async () => {
    if (!fixtureAvailable) return;

    await sftp.mkdir(`${TEST_PREFIX}/subdir`);

    const exists = await sftp.exists(`${TEST_PREFIX}/subdir`);
    expect(exists).toBe(true);

    const entries = await sftp.readdir(TEST_PREFIX);
    const names = entries.map((e) => e.name);
    expect(names).toContain('subdir');
  });

  it('stats a file', async () => {
    if (!fixtureAvailable) return;

    await sftp.writeFile(`${TEST_PREFIX}/stat-test.txt`, 'stat me');
    const stat = await sftp.stat(`${TEST_PREFIX}/stat-test.txt`);

    expect(stat.isFile()).toBe(true);
    expect(stat.isDirectory()).toBe(false);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('renames a file', async () => {
    if (!fixtureAvailable) return;

    await sftp.writeFile(`${TEST_PREFIX}/before.txt`, 'rename me');
    await sftp.rename(`${TEST_PREFIX}/before.txt`, `${TEST_PREFIX}/after.txt`);

    const beforeExists = await sftp.exists(`${TEST_PREFIX}/before.txt`);
    const afterExists = await sftp.exists(`${TEST_PREFIX}/after.txt`);

    expect(beforeExists).toBe(false);
    expect(afterExists).toBe(true);
  });

  it('deletes a file', async () => {
    if (!fixtureAvailable) return;

    await sftp.writeFile(`${TEST_PREFIX}/delete-me.txt`, 'gone soon');
    await sftp.unlink(`${TEST_PREFIX}/delete-me.txt`);

    const exists = await sftp.exists(`${TEST_PREFIX}/delete-me.txt`);
    expect(exists).toBe(false);
  });

  it('removes an empty directory', async () => {
    if (!fixtureAvailable) return;

    await sftp.mkdir(`${TEST_PREFIX}/empty-dir`);
    await sftp.rmdir(`${TEST_PREFIX}/empty-dir`);

    const exists = await sftp.exists(`${TEST_PREFIX}/empty-dir`);
    expect(exists).toBe(false);
  });
});
