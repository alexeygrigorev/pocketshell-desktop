import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ensureHelperUp, E2E_HOST_NAME, HOST_PORT, TEST_KEY, stopHelper } from './helpers';

/**
 * End-to-end test for the restructured navigation and the terminal wiring.
 *
 * Nav: host picker -> host (persistent session panel on the left, no host-level
 * tab bar) -> click a session -> its workspace fills the right pane with
 * Terminal/Conversation/Files tabs while the panel stays put -> close the
 * session -> back to the host list. Ports and Usage are host header buttons
 * that open overlays.
 *
 * Terminal: switching between the fixture's two sessions repeatedly used to
 * stack an extra xterm `onData`/`onResize` handler per switch, so tmux's
 * `ESC[>c` device-attributes probe was answered N times and the surplus
 * `0;276;0c` replies were echoed into the shell. The regression assertion
 * below reads the xterm DOM rows and requires that string to be absent.
 *
 * SAFETY: same guarded ~/.ssh/config seeding as core-flow.spec.ts — only runs
 * with POCKETSHELL_E2E_SEED_CONFIG=1, and restores the original on teardown.
 */

const SSH_CONFIG = resolve(homedir(), '.ssh', 'config');
const BEGIN_MARKER = '# >>> pocketshell-e2e-nav (temporary) >>>';
const END_MARKER = '# <<< pocketshell-e2e-nav (temporary) <<<';
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
  // `require('electron')` resolves to the real binary (electron.exe on Windows).
  // Pointing at electron/cli.js instead makes launch fail with "Process failed
  // to launch!", which is why core-flow.spec.ts cannot start the app today.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  const mainPath = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
  return electron.launch({
    executablePath: electronPath,
    args: [mainPath],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

/** Text currently rendered in the terminal's DOM rows. */
async function terminalText(page: Page): Promise<string> {
  return page.locator('.terminal-area .xterm-rows').first().innerText();
}

// Serial: the tests walk one app through a single navigation journey, so a
// failure must skip the rest rather than restart the worker and re-run
// beforeAll against a half-seeded config.
test.describe.configure({ mode: 'serial' });

test.describe('session-scoped navigation + terminal wiring', () => {
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
    // The host's default view is the session list — no tab bar at host level.
    await expect(page.getByText('sessions').first()).toBeVisible({ timeout: 15_000 });
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

  test('the host shows a folder session panel and no host-level tabs', async () => {
    // The panel is `root -> directory -> session`, three levels, always
    // (docs/SESSIONLIST.md §2). Both fixture sessions sit in $HOME ITSELF,
    // which has no root folder to be named after, so the whole fixture lands
    // in the `other` bucket, under one directory node.
    await expect(page.locator('.session-panel')).toBeVisible();
    await expect(page.locator('.folder-header')).toHaveCount(1);
    await expect(page.locator('.folder-header .folder-label')).toHaveText('other');
    await expect(page.locator('.folder-header .folder-count')).toHaveText('2');
    await expect(page.locator('.dir-header')).toHaveCount(1);
    // `$HOME` itself: the directory key collapses to `~`, so the header takes
    // `defaultLabelForPath`'s named fallback rather than the account name.
    await expect(page.locator('.dir-header .label')).toHaveText('~ (home)');
    await expect(page.locator('.session-row')).toHaveCount(2);
    // EVERY session row is a leaf under a directory header — a directory never
    // stands in for its session, however few it holds. The fixture cannot show
    // the one-session directory (both its sessions share `~`), so this pins
    // the invariant the counts can prove: no session row is left loose.
    await expect(page.locator('.session-row.child')).toHaveCount(2);
    await expect(page.locator('.session-row.orphan')).toHaveCount(0);
    // The row is labelled by its own session name; the header already said the
    // directory, so the row never repeats it.
    await expect(page.locator('.session-row.child .label').first()).not.toHaveText('~ (home)');
    await expect(page.locator('.row-name')).toHaveCount(0);
    // The `attached` tag stays retired — the dot, the weight and the sort say it.
    await expect(page.locator('.session-row .tag')).toHaveCount(0);
    // Files/Conversation are NOT host-level tabs any more.
    await expect(page.locator('.workspace > .body > nav.tabs')).toHaveCount(0);
    // Nothing selected yet -> the right pane shows the empty state.
    await expect(page.locator('.session-placeholder')).toBeVisible();
  });

  test('clicking a directory row toggles it and never opens a session', async () => {
    // The directory row stopped being selectable in docs/SESSIONLIST.md
    // revision 3: its session has a row of its own directly beneath it now, so
    // a click here can only mean "expand/collapse". `v-show` keeps the rows in
    // the DOM, hence toBeHidden rather than a count of 0.
    await page.locator('.dir-header').first().click();
    await expect(page.locator('.session-row').first()).toBeHidden();
    await expect(page.locator('.session-workspace')).toHaveCount(0);
    await expect(page.locator('.session-placeholder')).toBeVisible();
    await page.locator('.dir-header').first().click();
    await expect(page.locator('.session-row').first()).toBeVisible();
  });

  test('Ports and Usage are host header buttons that open overlays', async () => {
    await page.getByRole('button', { name: 'Ports' }).click();
    await expect(page.getByRole('dialog', { name: 'Port forwarding' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Port forwarding' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Usage' }).click();
    await expect(page.getByRole('dialog', { name: 'Provider usage' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Provider usage' })).toHaveCount(0);
  });

  test('selecting a session fills the right pane and keeps the panel visible', async () => {
    await page.locator('.session-row', { hasText: 'main' }).first().click();
    await expect(page.locator('.session-workspace')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Terminal' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Conversation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Files' })).toBeVisible();
    await expect(page.locator('.terminal-area > .terminal')).toBeVisible({ timeout: 15_000 });
    // The panel is persistent, and it marks the open session.
    await expect(page.locator('.session-panel')).toBeVisible();
    await expect(page.locator('.session-row.current')).toHaveCount(1);
    await expect(page.locator('.session-row.current')).toContainText('main');
  });

  test('there is a way back: close the session, then back to hosts', async () => {
    await page.getByTitle('Close session view').click();
    await expect(page.locator('.session-workspace')).toHaveCount(0);
    await expect(page.locator('.session-placeholder')).toBeVisible();
    await expect(page.locator('.session-row')).toHaveCount(2);
    await page.getByTitle('Back to hosts').click();
    await expect(page.getByText(E2E_HOST_NAME)).toBeVisible();
    // Return to the host for the remaining tests.
    await page.getByText(E2E_HOST_NAME).click();
    await expect(page.locator('.session-row').first()).toBeVisible({ timeout: 15_000 });
  });

  test('the session panel collapses and reappears', async () => {
    await page.getByTitle('Hide session panel').click();
    await expect(page.locator('.session-panel')).toBeHidden();
    await page.getByTitle('Show session panel').click();
    await expect(page.locator('.session-panel')).toBeVisible();
  });

  test('repeated session switching leaves no duplicated DA2 replies', async () => {
    for (let i = 0; i < 4; i += 1) {
      const target = i % 2 === 0 ? 'main' : 'build';
      await page.locator('.session-row', { hasText: target }).first().click();
      await expect(page.locator('.terminal-area > .terminal')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1200);
    }

    await page.locator('.session-row', { hasText: 'main' }).first().click();
    await expect(page.locator('.terminal-area > .terminal')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2000);
    expect(await terminalText(page)).not.toContain('0;276;0c');

    // One keystroke must reach the shell exactly once. `echo` a sentinel and
    // assert the echoed command line is not duplicated on the same row.
    await page.locator('.terminal-area > .terminal').first().click();
    await page.keyboard.type('echo nav_sentinel_ok', { delay: 10 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const text = await terminalText(page);
    expect(text).toContain('nav_sentinel_ok');
    expect(text).not.toContain('echo nav_sentinel_okecho');
    expect(text).not.toContain('0;276;0c');
  });

  test('selecting terminal text copies it on mouse-up', async () => {
    // Seed the clipboard with a sentinel so we can tell "copied" from "unchanged".
    await app.evaluate(({ clipboard }) => clipboard.writeText('__not_copied__'));

    const row = page.locator('.terminal-area .xterm-rows > div', { hasText: 'nav_sentinel_ok' }).first();
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    // Drag across the row to select it.
    await page.mouse.move(box!.x + 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width - 2, box!.y + box!.height / 2, { steps: 10 });
    await page.mouse.up();

    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
      .toContain('nav_sentinel_ok');
  });

  test('a click that clears the selection does not blank the clipboard', async () => {
    await page.mouse.click(400, 400);
    await page.waitForTimeout(500);
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('nav_sentinel_ok');
  });

  test('Ctrl+Shift+V pastes the clipboard into the shell', async () => {
    await app.evaluate(({ clipboard }) => clipboard.writeText('paste_probe_42'));
    await page.locator('.terminal-area > .terminal').first().click();
    await page.keyboard.press('Control+Shift+V');
    await expect
      .poll(() => terminalText(page), { timeout: 5_000 })
      .toContain('paste_probe_42');
  });
});
