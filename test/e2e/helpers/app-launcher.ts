import type { ElectronApplication } from '@playwright/test';

/**
 * Launcher for the PocketShell Desktop Electron application.
 *
 * STUB: The Electron app does not exist yet. These functions provide the
 * interface that future E2E tests will use once the app is built.
 * For now, calling launchApp() throws a clear error.
 */

export interface LaunchOptions {
  /** Extra arguments to pass to the Electron binary. */
  args?: string[];
  /** Environment variables to set. */
  env?: Record<string, string>;
}

/**
 * Launch the PocketShell Desktop Electron application.
 *
 * TODO: Replace with actual Electron launch once the app is built.
 * Expected implementation:
 *   import { _electron as electron } from '@playwright/test';
 *   const app = await electron.launch({ args: [APP_PATH, ...(options.args ?? [])] });
 */
export async function launchApp(_options?: LaunchOptions): Promise<ElectronApplication> {
  throw new Error(
    'PocketShell Desktop Electron app is not built yet. ' +
    'Implement app-launcher.ts once the app binary/package is available.',
  );
}

/**
 * Gracefully close the PocketShell Desktop Electron application.
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  if (app && typeof app.close === 'function') {
    await app.close();
  }
}
