import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { resetWorkspaceState, ensureHelperUp, E2E_HOST_NAME, HOST_PORT, TEST_KEY, stopHelper } from './helpers';

/**
 * End-to-end test: launch the real packaged Electron app against the
 * deterministic Docker `helper` container.
 *
 * Flow: host picker (seeded with a temporary ~/.ssh/config entry pointing at
 * the helper) -> connect -> session tree -> click a session -> terminal
 * attaches via `tmux attach` -> type a command -> assert visible output.
 *
 * SAFETY: this spec appends a guarded, marker-delimited block to the user's
 * real ~/.ssh/config and restores the original on teardown. It backs the file up first and restores
 * the original on teardown - the seed is part of the test, never an opt-in.
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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
    await resetWorkspaceState(page);
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
    // After connect the folder panel appears; sessions live one click deeper,
    // inside a folder workspace.
    await expect(page.locator('.dir-header').first()).toBeVisible({ timeout: 15_000 });
  });

  test('clicking a session opens the terminal and typing reaches the composer', async () => {
    // Sessions are tabs INSIDE a folder workspace now: open the folder, then
    // the session's tab.
    await page.locator('.dir-header').first().click();
    await expect(page.locator('.folder-workspace')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'main', exact: true }).click();
    const term = page.locator('.terminal-area > .terminal-slot:visible > .terminal');
    await expect(term).toBeVisible({ timeout: 15_000 });
    // Typing is the composer's door: printable keys open it and land in the
    // draft instead of the shell. Spaces are deliberately NOT typing keys —
    // they fall through to the pane — so the sentinel avoids them.
    await term.click();
    await page.keyboard.type('echo_e2e_sentinel', { delay: 5 });
    await expect(page.locator('.composer')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.composer .draft')).toHaveValue('echo_e2e_sentinel');
    await expect(term).toBeVisible();
  });
});
