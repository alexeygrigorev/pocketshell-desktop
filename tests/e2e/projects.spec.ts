import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  ensureHelperUp,
  execInFixture,
  seedProjectFolders,
  E2E_HOST_NAME,
  HOST_PORT,
  TEST_KEY,
  stopHelper,
} from './helpers';

/**
 * End-to-end test for folder-first session creation and the rebuilt port panel.
 *
 * The session panel used to end in a bare "new session name" text field. That
 * had the model backwards: a session belongs to a project FOLDER and its name
 * is derived from that folder, so a typed name produced sessions no other
 * PocketShell client could group. The field is gone; this spec asserts it is
 * gone and that the three folder routes replacing it work end to end against
 * the real helper (0.4.44) on the Docker fixture.
 *
 * Two fixture facts this spec leans on deliberately:
 *   - `seedProjectFolders()` creates `~/git/demo-repo` and `~/git/Hello-World`
 *     so the browser and the repo list both have real rows. It runs in
 *     `beforeAll`, not once: the helper IMAGE ships no `~/git`, and
 *     `ensureHelperUp` recreates the container whenever the image changes;
 *   - it ships NO `gh`, which is a NORMAL state — `reposList` still returns
 *     ok, the local clones still render, and the UI owes a hint rather than an
 *     error. That is asserted rather than worked around.
 *
 * SAFETY: same guarded ~/.ssh/config seeding as core-flow.spec.ts — only runs
 * with POCKETSHELL_E2E_SEED_CONFIG=1, and restores the original on teardown.
 */

const SSH_CONFIG = resolve(homedir(), '.ssh', 'config');
const BEGIN_MARKER = '# >>> pocketshell-e2e-projects (temporary) >>>';
const END_MARKER = '# <<< pocketshell-e2e-projects (temporary) <<<';
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

/**
 * Unique per run. The compose container survives a `stop`/`up` cycle, so a
 * fixed name would already exist on the second run and the first assertion
 * would see "Re-opened" where it expects "Started".
 */
const PROJECT_FOLDER = `e2e-proj-${Date.now().toString(36)}`;

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
  // `require('electron')` resolves to the real binary path (electron.exe on
  // Windows); the ESM import does not, and electron/cli.js is not launchable.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  const mainPath = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
  return electron.launch({
    executablePath: electronPath,
    args: [mainPath],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

// Serial: one app walks one journey; a failure must skip the rest rather than
// restart the worker and re-seed a half-written config.
test.describe.configure({ mode: 'serial' });

test.describe('folder-first session creation + port panel controls', () => {
  test.skip(
    !process.env['POCKETSHELL_E2E_SEED_CONFIG'],
    'set POCKETSHELL_E2E_SEED_CONFIG=1 to seed ~/.ssh/config and run the UI E2E',
  );

  let app: ElectronApplication;
  let page: Page;
  /** The name the dialog previewed, captured so the outcome can be matched. */
  let previewedName = '';

  test.beforeAll(async () => {
    ensureHelperUp();
    seedProjectFolders();
    originalConfig = existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, 'utf8') : '';
    appendFileSync(SSH_CONFIG, `\n${SEED_BLOCK}\n`);
    app = await launchApp();
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByText(E2E_HOST_NAME).click();
    await expect(page.locator('.dir-header').first()).toBeVisible({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    try {
      if (app) await app.close();
    } catch {
      // ignore
    }
    // Put the fixture back to its two seeded sessions. The container survives
    // a stop/start, so a session left running here would show up as a third
    // row in session-nav.spec.ts, which counts them.
    try {
      execInFixture([
        previewedName ? `tmux kill-session -t "${previewedName}" 2>/dev/null || true` : 'true',
        `rm -rf "$HOME/${PROJECT_FOLDER}"`,
      ]);
    } catch {
      // Best effort: the container may already be gone.
    }
    if (originalConfig !== null) writeFileSync(SSH_CONFIG, originalConfig);
    stopHelper();
  });

  test('the bare "new session name" field is gone', async () => {
    // The footer is a button that opens the folder picker, not a text field.
    await expect(page.locator('.new-session input')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
  });

  test('the picker offers three folder routes and previews the derived name', async () => {
    await page.getByRole('button', { name: 'New session' }).click();
    await expect(page.getByRole('dialog', { name: 'New session' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Existing folder' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'New folder' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Clone from GitHub' })).toBeVisible();

    // The browser lands on $HOME and the name preview is populated before
    // anything is committed — the whole point of deriving rather than typing.
    await expect(page.locator('.crumbs')).toContainText('~');
    await expect(page.locator('.preview-name')).not.toHaveText('—', { timeout: 20_000 });
  });

  test('browsing a folder re-derives the name from the path', async () => {
    await page.locator('.folder-row', { hasText: 'git' }).first().click();
    await expect(page.locator('.folder-row', { hasText: 'demo-repo' })).toBeVisible({
      timeout: 20_000,
    });
    await page.locator('.folder-row', { hasText: 'demo-repo' }).first().click();
    // `~/git/demo-repo` -> `git-demo-repo`, the same rule tmuxctl and the
    // Android app apply.
    await expect(page.locator('.preview-name')).toHaveText('git-demo-repo', { timeout: 20_000 });
    await expect(page.locator('.preview-path')).toContainText('~/git/demo-repo');
  });

  test('a host with no gh still lists local clones, with a hint not an error', async () => {
    await page.getByRole('tab', { name: 'Clone from GitHub' }).click();
    // The fixture has git but no GitHub CLI: `ok` stays true, the remote scope
    // is empty, and the local scan is unaffected.
    await expect(page.locator('.repo-row', { hasText: 'demo-repo' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('.repos .hint')).toContainText('GitHub CLI');
    // A hint, never a failure dialog.
    await expect(page.locator('.repos .error')).toHaveCount(0);
    // A repo already on disk needs no clone, and the UI says so.
    await page.locator('.repo-row', { hasText: 'demo-repo' }).first().click();
    await expect(page.locator('.repos')).toContainText('Already on the host');
  });

  test('the new-folder route creates the folder and starts the session', async () => {
    await page.getByRole('tab', { name: 'Existing folder' }).click();
    // Back to $HOME so the folder lands somewhere predictable.
    await page.getByTitle('Home folder').click();
    await expect(page.locator('.crumbs')).toContainText('~', { timeout: 20_000 });

    await page.getByRole('tab', { name: 'New folder' }).click();
    await page.locator('input[placeholder="my-project"]').fill(PROJECT_FOLDER);
    await expect(page.locator('.preview-path')).toContainText(PROJECT_FOLDER, { timeout: 20_000 });
    previewedName = (await page.locator('.preview-name').innerText()).trim();
    expect(previewedName).toContain(PROJECT_FOLDER);

    await page.getByRole('button', { name: 'Start session' }).click();
    await expect(page.locator('.result-banner')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.result-banner')).toHaveClass(/ok/);
    // The name the host chose is the name the picker previewed.
    await expect(page.locator('.result-title')).toContainText(previewedName);
    await expect(page.locator('.result-title')).toContainText('Started');
  });

  test('starting the same folder again is reported as a reuse, not a failure', async () => {
    await page.getByRole('button', { name: 'Start another' }).click();
    // A successful create leaves the browser standing IN the folder it just
    // made, so the existing-folder route is already aimed at it — and the
    // new-folder name field is cleared, deliberately, so "start another" cannot
    // re-run the same mkdir by accident.
    await page.getByRole('tab', { name: 'Existing folder' }).click();
    await expect(page.locator('.preview-name')).toHaveText(previewedName, { timeout: 20_000 });
    await page.getByRole('button', { name: 'Start session' }).click();
    await expect(page.locator('.result-banner')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.result-banner')).toHaveClass(/ok/);
    await expect(page.locator('.result-title')).toContainText('Re-opened');
    await expect(page.locator('.result-sub')).toContainText('reused');
  });

  test('opening the new session attaches its workspace', async () => {
    await page.getByRole('button', { name: 'Open session' }).click();
    await expect(page.getByRole('dialog', { name: 'New session' })).toHaveCount(0);
    // Creating from the panel now lands in the new session's FOLDER workspace,
    // with that session's tab selected — the panel highlights the folder.
    await expect(page.locator('.folder-workspace')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.dir-header.current')).toHaveCount(1);
    await expect(page.locator('.tab.active')).toBeVisible();
  });

  test('the port panel shows discovered ports with process and folder columns', async () => {
    await page.getByRole('button', { name: 'Ports' }).click();
    await expect(page.getByRole('dialog', { name: 'Port forwarding' })).toBeVisible();

    // Normalise the toggle. Auto-forward is PERSISTED per host (PortfwdStore),
    // so a previous suite run legitimately leaves it on and the assertions
    // below — which are about the un-forwarded state — would otherwise depend
    // on run order rather than on the code.
    if (await page.getByRole('button', { name: 'Auto-forward: ON' }).count()) {
      await page.getByRole('button', { name: 'Auto-forward: ON' }).click();
      await expect(page.getByRole('button', { name: 'Auto-forward: OFF' })).toBeVisible({
        timeout: 20_000,
      });
    }

    for (const column of ['Port', 'Name', 'Local', 'Process', 'Folder', 'Status', 'In', 'Out']) {
      await expect(page.locator('.fwd-table thead')).toContainText(column);
    }

    // sshd is always listening on the fixture, so at least one discovered row
    // exists even with auto-forward off.
    await expect(page.locator('.fwd-table tbody tr').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.fwd-table tbody tr', { hasText: '22' }).first()).toBeVisible();

    // Every discovered row carries the per-row controls, whether or not it is
    // currently forwarded — that is what makes a port above maxAutoPort
    // reachable at all.
    const first = page.locator('.fwd-table tbody tr').first();
    await expect(first.locator('.c-name .cell-input')).toBeEnabled();
    await expect(first.locator('.c-local .cell-input')).toBeEnabled();
    await expect(first.locator('.actions .icon-btn').first()).toBeEnabled();
    // Nothing is forwarded yet, so removal has nothing to act on.
    await expect(first.locator('.actions .icon-btn').last()).toBeDisabled();
  });

  test('auto-forward turns on without a structured-clone failure', async () => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // The previous test left the toggle OFF, so this is the OFF -> ON
    // transition — the one that carries the ssh-config LocalForward list
    // across the bridge. Passing the Pinia proxy straight through used to fail
    // structured cloning and kill the toggle silently, with nothing on screen
    // to say so.
    await page.getByRole('button', { name: 'Auto-forward: OFF' }).click();
    await expect(page.getByRole('button', { name: 'Auto-forward: ON' })).toBeVisible({
      timeout: 20_000,
    });
    expect(errors.join('\n')).not.toContain('could not be cloned');

    // Leave the host as we found it, since the setting outlives the run.
    await page.getByRole('button', { name: 'Auto-forward: ON' }).click();
    await expect(page.getByRole('button', { name: 'Auto-forward: OFF' })).toBeVisible({
      timeout: 20_000,
    });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Port forwarding' })).toHaveCount(0);
  });
});
