/**
 * E2E test: Auto-connect to last host on startup.
 *
 * Verifies that when the app is restarted, it automatically reconnects
 * to the host that was most recently used.
 *
 * TODO: This test requires the Electron app to be built and the Docker SSH
 * fixture to be running. Until the app shell is available, this test is
 * skipped. When the app is ready, replace the stubs with real app launch and
 * IPC assertions.
 */

import { test, expect } from '@playwright/test';
import {
  startFixture,
  stopFixture,
  isFixtureRunning,
  DEFAULT_FIXTURE,
} from './helpers/docker-fixture';
import { waitForSSH } from './helpers/ssh-helpers';

const { host, port, user, keyPath } = DEFAULT_FIXTURE;

test.describe('Auto-connect on startup', () => {
  test.skip(
    () => true,
    'App shell not yet available — stub test, enable when Electron app is built',
  );

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

  test('auto-connects to last-used host after app restart', async () => {
    // TODO: Implement once the Electron app shell exists.
    //
    // Steps:
    // 1. Launch the app
    // 2. Add the Docker SSH fixture as a host
    // 3. Connect to it manually
    // 4. Close the app
    // 5. Relaunch the app
    // 6. Assert that the auto-connect service emits 'connected'
    //    for the Docker fixture host
    //
    // Expected assertion (pseudocode):
    //   const status = await appIpc.waitFor('auto-connect:connected');
    //   expect(status.host.hostname).toBe(host);
    //   expect(status.host.port).toBe(port);

    expect(true).toBe(true);
  });

  test('does not auto-connect when feature is disabled', async () => {
    // TODO: Implement once the Electron app shell exists.
    //
    // Steps:
    // 1. Launch the app
    // 2. Disable auto-connect in settings
    // 3. Ensure a host exists with lastConnectedAt set
    // 4. Close and relaunch the app
    // 5. Assert that the auto-connect service emits 'skipped'

    expect(true).toBe(true);
  });

  test('emits no-hosts on first launch with empty host list', async () => {
    // TODO: Implement once the Electron app shell exists.
    //
    // Steps:
    // 1. Launch the app with a fresh config directory (no hosts)
    // 2. Assert that the auto-connect service emits 'no-hosts'

    expect(true).toBe(true);
  });
});
