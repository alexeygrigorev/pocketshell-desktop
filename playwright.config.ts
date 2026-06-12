import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for PocketShell Desktop E2E tests.
 *
 * Tests run against the Docker SSH fixture (localhost:2222).
 * The Electron app launcher is stubbed until the app is built.
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'electron',
      use: {
        // Electron app launcher will be configured per-test via helpers.
        // No base URL — the app launches its own window.
      },
    },
  ],
});
