import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ensureHelperUp, E2E_HOST_NAME, HOST_PORT, TEST_KEY, stopHelper } from './helpers';

/**
 * End-to-end coverage for the prompt composer panel.
 *
 * What is worth asserting in a real app (as opposed to the store unit tests in
 * tests/unit/composerStore.test.ts):
 *
 *  - the panel is a VS Code-style dock: it SHRINKS the terminal instead of
 *    covering it, and the tab content above it stays rendered;
 *  - hiding it leaves a discoverable rail, and the draft survives the round trip
 *    (the whole reason the rail exists — a preserved "Not sent" draft must never
 *    become invisible);
 *  - drafts are per session, and coming back restores yours (the desktop's
 *    deliberate improvement over the phone's discard-on-switch, COMPOSER.md §12.4);
 *  - a multi-line prompt reaches the pane as ONE submission carrying every line,
 *    which is the bracketed-paste framing working against a real PTY (§16.2);
 *  - Escape never destroys the draft.
 *
 * SAFETY: same guarded ~/.ssh/config seeding as the other UI specs — only runs
 * with POCKETSHELL_E2E_SEED_CONFIG=1, and restores the original on teardown.
 */

const SSH_CONFIG = resolve(homedir(), '.ssh', 'config');
const BEGIN_MARKER = '# >>> pocketshell-e2e-composer (temporary) >>>';
const END_MARKER = '# <<< pocketshell-e2e-composer (temporary) <<<';
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
  const { _electron } = await import('playwright');
  const electron = _electron as unknown as {
    launch(opts: {
      executablePath: string;
      args: string[];
      env: NodeJS.ProcessEnv;
    }): Promise<ElectronApplication>;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  const mainPath = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
  return electron.launch({
    executablePath: electronPath,
    args: [mainPath],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

async function terminalText(page: Page): Promise<string> {
  return page.locator('.terminal-area .xterm-rows').first().innerText();
}

/** Empty the draft field in place. Ctrl+A/Backspace inside a textarea. */
async function clearDraft(page: Page): Promise<void> {
  await page.locator('.composer .draft').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.composer .draft')).toHaveValue('');
}

async function openSession(page: Page, name: string): Promise<void> {
  await page.locator('.session-row', { hasText: name }).first().click();
  await expect(page.locator('.composer')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.terminal-area > .terminal')).toBeVisible({ timeout: 15_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('prompt composer panel', () => {
  test.skip(
    !process.env['POCKETSHELL_E2E_SEED_CONFIG'],
    'set POCKETSHELL_E2E_SEED_CONFIG=1 to seed ~/.ssh/config and run the UI E2E',
  );

  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    ensureHelperUp();
    originalConfig = existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, 'utf8') : '';
    appendFileSync(SSH_CONFIG, `\n${SEED_BLOCK}\n`);
    app = await launchApp();
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByText(E2E_HOST_NAME).click();
    await expect(page.locator('.session-row').first()).toBeVisible({ timeout: 20_000 });
    await openSession(page, 'main');
  });

  test.afterAll(async () => {
    try {
      if (app) await app.close();
    } catch {
      // ignore
    }
    if (originalConfig !== null) writeFileSync(SSH_CONFIG, originalConfig);
    stopHelper();
  });

  test('docks below the terminal without covering it', async () => {
    await expect(page.locator('.composer .panel-header')).toBeVisible();
    await expect(page.locator('.composer .draft')).toBeVisible();
    await expect(page.locator('.composer .send')).toBeVisible();
    await expect(page.locator('.composer .sash')).toBeVisible();

    // The tab content above is still rendered, and the panel starts below it.
    const term = await page.locator('.terminal-area > .terminal').boundingBox();
    const panel = await page.locator('.composer').boundingBox();
    expect(term).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(term!.height).toBeGreaterThan(100);
    expect(panel!.y).toBeGreaterThanOrEqual(term!.y + term!.height - 2);
  });

  test('Send is disabled until there is something to send', async () => {
    await clearDraft(page);
    await expect(page.locator('.composer .send')).toBeDisabled();
    await page.locator('.composer .draft').click();
    await page.keyboard.type('hello there');
    await expect(page.locator('.composer .send')).toBeEnabled();
  });

  test('Escape blurs the draft but never clears it', async () => {
    await page.locator('.composer .draft').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.composer .draft')).toHaveValue('hello there');
    await expect(page.locator('.composer')).toBeVisible();
  });

  test('closing leaves a rail that advertises the unsent draft, and reopens it', async () => {
    await page.locator('.composer .panel-action').nth(1).click();
    await expect(page.locator('.composer .rail')).toBeVisible();
    await expect(page.locator('.composer .draft')).toHaveCount(0);
    // The rail says a draft is waiting — the whole point of keeping it.
    await expect(page.locator('.composer .draft-dot')).toBeVisible();

    await page.locator('.composer .rail').click();
    await expect(page.locator('.composer .draft')).toHaveValue('hello there');
  });

  test('Ctrl+` toggles the panel from the terminal', async () => {
    await page.locator('.terminal-area > .terminal').first().click();
    await page.keyboard.press('Control+`');
    await expect(page.locator('.composer .rail')).toBeVisible();
    await page.keyboard.press('Control+`');
    await expect(page.locator('.composer .draft')).toHaveValue('hello there');
  });

  test('maximize and restore keep the draft and return a usable terminal', async () => {
    await page.locator('.composer .panel-action').first().click();
    const maximized = await page.locator('.composer').boundingBox();
    await page.locator('.composer .panel-action').first().click();
    const restored = await page.locator('.composer').boundingBox();
    expect(maximized!.height).toBeGreaterThan(restored!.height);
    await expect(page.locator('.composer .draft')).toHaveValue('hello there');
    await expect(page.locator('.terminal-area > .terminal')).toBeVisible();
  });

  test('drafts are per session and survive switching away and back', async () => {
    await openSession(page, 'build');
    // Drafts persist to disk across app restarts, so a re-run of this suite can
    // find one already here — clear it rather than asserting it is empty.
    await clearDraft(page);
    await page.keyboard.type('build-only draft');

    await openSession(page, 'main');
    await expect(page.locator('.composer .draft')).toHaveValue('hello there');

    await openSession(page, 'build');
    await expect(page.locator('.composer .draft')).toHaveValue('build-only draft');
    // Leave nothing behind for the next run.
    await clearDraft(page);
  });

  test('a multi-line prompt reaches the pane carrying every line', async () => {
    await openSession(page, 'main');
    await page.locator('.composer .draft').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('echo bp_line_one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('echo bp_line_two');
    await expect(page.locator('.composer .draft')).toHaveValue(
      'echo bp_line_one\necho bp_line_two',
    );

    await page.keyboard.press('Enter');

    // Delivered -> the draft clears and the panel STAYS OPEN (COMPOSER.md §12.3).
    await expect(page.locator('.composer .draft')).toHaveValue('', { timeout: 15_000 });
    await expect(page.locator('.composer .draft')).toBeVisible();

    await expect
      .poll(() => terminalText(page), { timeout: 15_000 })
      .toContain('bp_line_one');
    expect(await terminalText(page)).toContain('bp_line_two');
  });
});
