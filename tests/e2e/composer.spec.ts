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
 *  - the panel is a floating card: it overlays the tab content rather than
 *    splitting the pane with it, and — the guarantee that matters — the
 *    terminal's own box is IDENTICAL open and closed, because a panel that
 *    resized the terminal would resize the remote tmux with it;
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

  test('floats over the terminal without resizing it', async () => {
    await expect(page.locator('.composer .panel-header')).toBeVisible();
    await expect(page.locator('.composer .draft')).toBeVisible();
    await expect(page.locator('.composer .send')).toBeVisible();
    await expect(page.locator('.composer .sash')).toBeVisible();

    const term = await page.locator('.terminal-area > .terminal').boundingBox();
    const panel = await page.locator('.composer').boundingBox();
    const body = await page.locator('.session-body').boundingBox();
    expect(term).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(term!.height).toBeGreaterThan(100);

    // A card, not a bar: inset from the pane on every side it touches, and
    // narrower than the pane, so terminal output stays readable beside it.
    expect(panel!.x).toBeGreaterThan(body!.x);
    expect(panel!.x + panel!.width).toBeLessThan(body!.x + body!.width);
    expect(panel!.y + panel!.height).toBeLessThan(body!.y + body!.height);
    // Anchored to the RIGHT: its right edge is the near one.
    expect(body!.x + body!.width - (panel!.x + panel!.width)).toBeLessThan(
      panel!.x - body!.x,
    );

    // The guarantee: closing and re-opening the panel leaves the terminal the
    // exact same size, so the remote tmux is never asked to reflow.
    await page.locator('.composer .panel-action').nth(1).click();
    await expect(page.locator('.composer .rail')).toBeVisible();
    const closed = await page.locator('.terminal-area > .terminal').boundingBox();
    expect(closed!.height).toBe(term!.height);
    expect(closed!.width).toBe(term!.width);

    // ...and the rail pill is the one state that covers no terminal row at all.
    const rail = await page.locator('.composer').boundingBox();
    expect(rail!.y).toBeGreaterThanOrEqual(closed!.y + closed!.height - 1);

    await page.locator('.composer .rail').click();
    await expect(page.locator('.composer .draft')).toBeVisible();
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
    // The pill says a draft is waiting by SHOWING it: a dot could only raise
    // the question of which unsent prompt was sitting there.
    await expect(page.locator('.composer .ghost')).toHaveText('hello there');

    await page.locator('.composer .rail').click();
    await expect(page.locator('.composer .draft')).toHaveValue('hello there');
  });

  test('does not restate the session name inside the composer', async () => {
    // The session bar names the session one row above, and the composer is
    // mounted inside that session's workspace — it could never have meant
    // another one.
    const header = page.locator('.composer .panel-header');
    await expect(header).toBeVisible();
    await expect(header).toHaveText('Prompt');
    await expect(page.locator('.composer .panel-scope')).toHaveCount(0);
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

  test('the card can be dragged around the pane by its header', async () => {
    const composer = page.locator('.composer');
    const before = await composer.boundingBox();
    const body = await page.locator('.session-body').boundingBox();

    // Grab the title bar well clear of the maximize/close buttons.
    const header = await page.locator('.composer .panel-header').boundingBox();
    await page.mouse.move(header!.x + 40, header!.y + header!.height / 2);
    await page.mouse.down();
    await page.mouse.move(header!.x - 260, header!.y - 160, { steps: 12 });
    await page.mouse.up();

    const after = await composer.boundingBox();
    expect(after!.x).toBeLessThan(before!.x - 100);
    expect(after!.y).toBeLessThan(before!.y - 100);
    // Same card, just somewhere else.
    expect(Math.round(after!.width)).toBe(Math.round(before!.width));
    // Still fully inside the pane: there is no half-lost state to recover from.
    expect(after!.x).toBeGreaterThanOrEqual(body!.x);
    expect(after!.y).toBeGreaterThanOrEqual(body!.y);
    expect(after!.x + after!.width).toBeLessThanOrEqual(body!.x + body!.width + 1);
    await expect(page.locator('.composer .draft')).toHaveValue('hello there');
  });

  test('the card resizes in BOTH axes from its edges', async () => {
    const composer = page.locator('.composer');
    const before = await composer.boundingBox();

    // West edge: drag it left, and only the width changes.
    await page.mouse.move(before!.x + 2, before!.y + before!.height / 2);
    await page.mouse.down();
    await page.mouse.move(before!.x - 120, before!.y + before!.height / 2, { steps: 10 });
    await page.mouse.up();
    const wider = await composer.boundingBox();
    expect(wider!.width).toBeGreaterThan(before!.width + 80);
    expect(Math.round(wider!.height)).toBe(Math.round(before!.height));
    // The right edge — the one NOT dragged — has not moved.
    expect(Math.round(wider!.x + wider!.width)).toBe(Math.round(before!.x + before!.width));

    // North edge: drag it up, and only the height changes.
    await page.mouse.move(wider!.x + wider!.width / 2, wider!.y + 2);
    await page.mouse.down();
    await page.mouse.move(wider!.x + wider!.width / 2, wider!.y - 90, { steps: 10 });
    await page.mouse.up();
    const taller = await composer.boundingBox();
    expect(taller!.height).toBeGreaterThan(wider!.height + 60);
    expect(Math.round(taller!.width)).toBe(Math.round(wider!.width));
  });

  test('the card’s geometry is shared by every session, like open/closed', async () => {
    const mine = await page.locator('.composer').boundingBox();
    await openSession(page, 'build');
    const theirs = await page.locator('.composer').boundingBox();
    expect(Math.round(theirs!.x)).toBe(Math.round(mine!.x));
    expect(Math.round(theirs!.width)).toBe(Math.round(mine!.width));
    await openSession(page, 'main');
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

  test('closing it keeps it closed when you switch session', async () => {
    // Open/closed is a preference about the tool, not a fact about a session:
    // it used to be stored per session, so a session the composer had never
    // been opened on started from its default — open — and closing the panel
    // was undone by the next session switch.
    await openSession(page, 'main');
    await page.locator('.composer .panel-action').nth(1).click();
    await expect(page.locator('.composer .rail')).toBeVisible();

    await page.locator('.session-row', { hasText: 'build' }).first().click();
    await expect(page.locator('.composer .rail')).toBeVisible();
    await expect(page.locator('.composer .draft')).toHaveCount(0);

    // Re-opening restores the panel, and the draft belonging to THIS session.
    await page.locator('.composer .rail').click();
    await expect(page.locator('.composer .draft')).toHaveValue('');
  });

  test('the terminal’s last row is not sliced by its own container', async () => {
    // tmux's status line is the bottom row and the one the user reads
    // constantly. It gets clipped when xterm is told it has more room than the
    // container's CONTENT box actually has: FitAddon reads
    // getComputedStyle(parent).height, which under `box-sizing: border-box`
    // INCLUDES the container's padding, and then subtracts only the padding of
    // its own element. Assert the drawn screen fits the box that clips it.
    const fit = await page.evaluate(() => {
      const host = document.querySelector('.terminal-area > .terminal');
      const screen = host?.querySelector('.xterm-screen');
      if (!host || !screen) return null;
      const cs = getComputedStyle(host);
      const hostRect = host.getBoundingClientRect();
      return {
        screenBottom: screen.getBoundingClientRect().bottom,
        contentBottom: hostRect.bottom - parseFloat(cs.paddingBottom),
      };
    });
    expect(fit).not.toBeNull();
    expect(fit!.screenBottom).toBeLessThanOrEqual(fit!.contentBottom + 1);
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
  test('draws a blank doodle and stages it as an image attachment', async () => {
    await openSession(page, 'main');
    await clearDraft(page);

    // The tools pill: paperclip, doodle, slash. The doodle button is the one
    // that opens a modal rather than a native dialog, which is why this flow
    // can be driven end to end here at all.
    await page.locator('.composer .pill .tool').nth(1).click();
    await expect(page.locator('.overlay-panel')).toBeVisible();
    await expect(page.locator('.doodle-sources')).toBeVisible();

    await page.locator('.source', { hasText: 'Blank sheet' }).click();
    const sheet = page.locator('.doodle .sheet');
    await expect(sheet).toBeVisible();

    // Undo and Clear start disabled: an empty sheet has nothing to undo, and
    // an enabled control that does nothing is a lie about the state.
    const undo = page.locator('.doodle .toolbar .tool-btn[title="Undo"]');
    await expect(undo).toBeDisabled();

    // Drag a stroke across the canvas with the pen.
    const box = await sheet.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width * 0.25, box!.y + box!.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.6, { steps: 12 });
    await page.mouse.move(box!.x + box!.width * 0.75, box!.y + box!.height * 0.4, { steps: 12 });
    await page.mouse.up();

    // The stroke landed, so undo now has something to undo.
    await expect(undo).toBeEnabled();

    await page.locator('.doodle .btn.primary').click();

    // The overlay closes and the drawing arrives as an ordinary staged tile —
    // uploaded over the SAME path a pasted screenshot takes, with a data-URL
    // thumbnail rather than the generic file glyph.
    await expect(page.locator('.overlay-panel')).toHaveCount(0);
    const tile = page.locator('.composer .tile').first();
    await expect(tile).toBeVisible({ timeout: 20_000 });
    await expect(tile.locator('.name')).toContainText('doodle-');
    const thumb = tile.locator('img.thumb');
    await expect(thumb).toBeVisible();
    expect(await thumb.getAttribute('src')).toMatch(/^data:image\/png;base64,/);

    // The draft is untouched: attaching never mutates the text (COMPOSER.md
    // §5.1) — the remote path is folded in at send time only.
    await expect(page.locator('.composer .draft')).toHaveValue('');

    // Leave nothing staged for the next run.
    await tile.locator('.remove').click();
    await expect(page.locator('.composer .tile')).toHaveCount(0);
  });

  test('offers all four image sources and can back out of the host browser', async () => {
    await page.locator('.composer .pill .tool').nth(1).click();
    const sources = page.locator('.doodle-sources .source');
    await expect(sources).toHaveCount(4);
    await expect(sources.nth(0)).toContainText('Blank sheet');
    await expect(sources.nth(1)).toContainText('From the clipboard');
    await expect(sources.nth(2)).toContainText('From this computer');
    await expect(sources.nth(3)).toContainText('From the host');

    // The host browser lists the remote filesystem over the live SFTP session.
    await sources.nth(3).click();
    await expect(page.locator('.picker')).toBeVisible();
    await expect(page.locator('.picker .crumbs')).toBeVisible();

    // Cancel returns to the chooser rather than closing the whole overlay —
    // picking the wrong source should cost one click, not the whole flow.
    await page.locator('.picker .btn').click();
    await expect(page.locator('.doodle-sources')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.overlay-panel')).toHaveCount(0);
  });
});
