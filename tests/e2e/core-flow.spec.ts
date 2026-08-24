import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ensureHelperUp, E2E_HOST_NAME, HOST_PORT, TEST_KEY, stopHelper } from './helpers';

/**
 * End-to-end test: launch the real packaged Electron app against the
 * deterministic Docker `helper` container.
 *
 * Flow: host picker (seeded with a temporary ~/.ssh/config entry pointing at
 * the helper) -> connect -> session tree -> click a session -> terminal
 * attaches via `tmux attach` -> type a command -> assert visible output.
 *
 * SAFETY: this spec appends a guarded, marker-delimited block to the user's
 * real ~/.ssh/config and restores the original on teardown. It only runs when
 * POCKETSHELL_E2E_SEED_CONFIG=1 is set, so it never touches the user's config
 * without explicit opt-in. Without the flag the spec is skipped.
 */

const SSH_CONFIG = resolve(homedir(), '.ssh', 'config');
const BEGIN_MARKER = '# >>> pocketshell-e2e (temporary) >>>';
const END_MARKER = '# <<< pocketshell-e2e (temporary) <<<';
const SEED_BLOCK = [
  BEGIN_MARKER,
  `Host ${E2E_HOST_NAME}`,
  `  HostName 127.0.0.1`,
  `  Port ${HOST_PORT}`,
  `  User testuser`,
  `  IdentityFile ${TEST_KEY}`,
  `  StrictHostKeyChecking no`,
  `  UserKnownHostsFile /dev/null`,
  END_MARKER,
].join('\n');

let originalConfig: string | null = null;

async function launchApp(): Promise<ElectronApplication> {
  // electron-vite dev server must be running, OR we run the built main.
  // For E2E we run the built app pointed at the dev server URL.
  const { _electron } = await import('playwright');
  const electron = _electron as unknown as {
    launch(opts: { executablePath: string; args: string[]; env: NodeJS.ProcessEnv }): Promise<ElectronApplication>;
  };
  // Use the project's electron to run the built main + preload + renderer.
  // `require('electron')` resolves to the real binary (electron.exe on
  // Windows); electron/cli.js is not launchable and fails with
  // "Process failed to launch!".
  const electronPath = require('electron') as unknown as string;
  const mainPath = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
  return electron.launch({
    executablePath: electronPath,
    args: [mainPath],
    env: {
      ...process.env,
      // Load the built renderer (electron-vite preview / file fallback).
      NODE_ENV: 'production',
    },
  });
}

test.describe('core terminal flow (host -> tree -> terminal)', () => {
  test.skip(
    !process.env['POCKETSHELL_E2E_SEED_CONFIG'],
    'set POCKETSHELL_E2E_SEED_CONFIG=1 to seed ~/.ssh/config and run the UI E2E',
  );

  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    ensureHelperUp();
    // Back up + seed the ssh config.
    originalConfig = existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, 'utf8') : '';
    appendFileSync(SSH_CONFIG, `\n${SEED_BLOCK}\n`);
    app = await launchApp();
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    try {
      if (app) await app.close();
    } catch {
      // ignore
    }
    // Restore the original ssh config exactly.
    if (originalConfig !== null) {
      writeFileSync(SSH_CONFIG, originalConfig);
    }
    stopHelper();
  });

  test('host picker lists the seeded host', async () => {
    // The host picker loads hosts on mount; wait for our seeded host row.
    await expect(page.getByText(E2E_HOST_NAME)).toBeVisible({ timeout: 10_000 });
  });

  test('clicking the host connects and shows the session tree', async () => {
    await page.getByText(E2E_HOST_NAME).click();
    // After connect, the workspace's session tree appears with the seeded
    // "main" session from the helper entrypoint.
    await expect(page.getByText('sessions').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('main')).toBeVisible({ timeout: 10_000 });
  });

  test('clicking a session opens the terminal and renders input', async () => {
    await page.getByText('main').click();
    // The xterm canvas takes focus; type a command. xterm renders to a
    // canvas, so we assert on the terminal container being live and then
    // drive input + wait briefly for it to be processed.
    const term = page.locator('.terminal').first();
    await expect(term).toBeVisible({ timeout: 10_000 });
    // Give the attach a moment, then type. We can't easily read canvas
    // pixels, so this is a smoke assertion: the terminal pane exists and
    // accepts focus after attach.
    await term.click();
    await page.keyboard.type('echo e2e_sentinel', { delay: 5 });
    await page.keyboard.press('Enter');
    // Allow the round-trip; no assertion on canvas text (see TESTING.md note
    // on terminal E2E — the integration test covers the rendered bytes).
    await page.waitForTimeout(1500);
    await expect(term).toBeVisible();
  });
});
