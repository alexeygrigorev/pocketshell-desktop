import { test, expect } from '@playwright/test';
import * as path from 'path';
import {
  startFixture,
  stopFixture,
  isFixtureRunning,
  DEFAULT_FIXTURE,
} from './helpers/docker-fixture';
import { sshExec, waitForSSH } from './helpers/ssh-helpers';

const { host, port, user, keyPath } = DEFAULT_FIXTURE;

test.describe('Connection lifecycle E2E tests', () => {
  let weStartedFixture = false;

  test.beforeAll(async () => {
    const running = await isFixtureRunning();
    if (!running) {
      await startFixture();
      weStartedFixture = true;
    }
    await waitForSSH(host, port, user, keyPath, 60_000);
  });

  test.afterAll(async () => {
    if (weStartedFixture) {
      await stopFixture();
    }
  });

  test('Connect to Docker fixture', async () => {
    const result = await sshExec(host, port, user, keyPath, 'whoami');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(user);
  });

  test('Execute command on connection', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'hostname && uname -s && date +%Y',
    );
    expect(result.exitCode).toBe(0);

    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBe(3);
    // uname should report Linux (Alpine container)
    expect(lines[1]).toBe('Linux');
    // Year should be a 4-digit number
    expect(lines[2]).toMatch(/^\d{4}$/);
  });

  test('Execute long-running command completes within timeout', async () => {
    // A command that takes a few seconds should still complete
    const result = await sshExec(
      host, port, user, keyPath,
      'sleep 2 && echo done',
      10_000, // 10s timeout — generous for a 2s sleep
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('done');
  });

  test('Handle connection timeout gracefully', async () => {
    // Use a very short timeout and a slow command to trigger a timeout.
    // The sshExec should reject with a timeout error, not hang.
    await expect(
      sshExec(host, port, user, keyPath, 'sleep 30', 2_000),
    ).rejects.toThrow(/timed out/i);
  });

  test('Multiple sequential connections work', async () => {
    // Open and close multiple SSH connections in sequence to verify
    // the fixture handles repeated connect/disconnect cycles
    const connectionCount = 5;

    for (let i = 0; i < connectionCount; i++) {
      const result = await sshExec(
        host, port, user, keyPath,
        `echo "connection-${i}"`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(`connection-${i}`);
    }
  });

  test('Multiple concurrent connections work', async () => {
    // Open several SSH connections simultaneously
    const connectionCount = 5;
    const promises = [];

    for (let i = 0; i < connectionCount; i++) {
      promises.push(
        sshExec(host, port, user, keyPath, `echo "concurrent-${i}"`),
      );
    }

    const results = await Promise.all(promises);

    for (let i = 0; i < connectionCount; i++) {
      expect(results[i].exitCode).toBe(0);
      expect(results[i].stdout.trim()).toBe(`concurrent-${i}`);
    }
  });

  test('Connection with wrong credentials fails', async () => {
    // Attempt to connect with a nonexistent user
    await expect(
      sshExec(host, port, 'nonexistent-user', keyPath, 'whoami'),
    ).rejects.toThrow();
  });

  test('Connection with wrong key fails', async () => {
    // Attempt to connect with a key that is not authorized.
    // We use the public key file as a "wrong" private key.
    const wrongKeyPath = path.resolve(
      __dirname,
      '../fixtures/docker/test_key.pub',
    );

    await expect(
      sshExec(host, port, user, wrongKeyPath, 'whoami'),
    ).rejects.toThrow();
  });

  test('Connection to wrong port fails', async () => {
    await expect(
      sshExec(host, 9999, user, keyPath, 'whoami', 3_000),
    ).rejects.toThrow();
  });

  test('Large output is captured completely', async () => {
    // Generate 1000 lines and verify all are captured
    const result = await sshExec(
      host, port, user, keyPath,
      'seq 1 1000',
    );
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBe(1000);
    expect(lines[0]).toBe('1');
    expect(lines[999]).toBe('1000');
  });

  test('waitForSSH succeeds when fixture is running', async () => {
    // If we got this far, the fixture is definitely running.
    // Verify waitForSSH completes quickly.
    const start = Date.now();
    await waitForSSH(host, port, user, keyPath, 10_000);
    const elapsed = Date.now() - start;
    // Should complete in well under the timeout
    expect(elapsed).toBeLessThan(10_000);
  });

  test('isFixtureRunning reports true for running fixture', async () => {
    const running = await isFixtureRunning();
    expect(running).toBe(true);
  });
});
