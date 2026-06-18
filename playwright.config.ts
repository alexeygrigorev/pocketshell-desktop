import { defineConfig } from '@playwright/test';

// E2E tests launch the packaged Electron app against a fixed Docker
// compose port (see docs/TESTING.md). They require the `helper` compose
// service to be up on 127.0.0.1:2225.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // single app + single compose target
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html']] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
