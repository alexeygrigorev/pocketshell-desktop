import { app, BrowserWindow, shell } from 'electron';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConnectionRegistry } from './ssh/ConnectionRegistry.js';
import { SshService } from './ssh/SshService.js';
import { PocketshellClient } from './helper/PocketshellClient.js';
import { SftpService } from './sftp/SftpService.js';
import { ForwardService } from './portfwd/ForwardService.js';
import { ProjectsService } from './projects/ProjectsService.js';
import { registerIpcHandlers } from './ipc.js';
import { APP_TITLE } from '../shared/windowTitle.js';
import { ipc } from '../shared/channels.js';
import { zoomCommandForInput } from '../shared/zoomKeys.js';

// Electron + ESM: __dirname is not defined for the bundled output under some
// loaders; electron-vite emits CJS for main, so __dirname is available. We
// resolve defensively either way.
const __dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));

const registry = new ConnectionRegistry();
const ssh = new SshService(registry);
const helper = new PocketshellClient(ssh);
const sftp = new SftpService(registry);
const forwards = new ForwardService(ssh, registry);
const projects = new ProjectsService(ssh, helper);
// Evict cached per-connection state (SFTP wrapper, forwarders, remote $HOME)
// on close.
ssh.onCloseConnection((id) => {
  sftp.evict(id);
  forwards.evict(id);
  projects.evict(id);
});

let mainWindow: BrowserWindow | null = null;

/**
 * The window icon, or undefined when the generated file is not present.
 *
 * Only unpackaged runs need this. A packaged Windows build takes its icon
 * from the .exe resource and a packaged macOS build from the bundle, both
 * written by electron-builder from build/icon.* — so `build/` is deliberately
 * absent from the `files` allow-list in electron-builder.yml and this lookup
 * simply misses there. It matters for `npm run dev` and for the desktop
 * shortcut (scripts/install-desktop-shortcut.ps1), which launch Electron
 * directly and would otherwise show the default Electron atom in the taskbar.
 */
function windowIcon(): string | undefined {
  const icon = join(__dir, '../../build/icon.png');
  return existsSync(icon) ? icon : undefined;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // The launch title only. Once connected, the renderer retitles the window
    // with the host's identity over `win:setTitle` (the workspace has no
    // identity bar of its own — the native title bar carries it).
    title: APP_TITLE,
    icon: windowIcon(),
    webPreferences: {
      preload: join(__dir, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium's built-in PDF viewer is a "plugin" as far as Electron's API
      // is concerned, and this is the flag its documentation names for it.
      // The Files tab renders a remote PDF by putting its bytes behind a blob
      // URL and pointing an `<embed type="application/pdf">` at it.
      //
      // Measured on this exact Electron (33.3.1) rather than assumed: the
      // viewer paints from a blob URL with this flag BOTH true and false —
      // `navigator.pdfViewerEnabled` is true either way, and a screenshot of
      // the embed shows the real viewer chrome and the page. So on this
      // version the flag is not what makes it work; the CSP is (see
      // renderer/index.html — without `object-src blob:` the same embed emits
      // a policy violation and paints nothing).
      //
      // It stays on anyway because it is the documented contract, it costs
      // nothing here, and a version or platform where the default flips back
      // would fail SILENTLY — a blank frame with no error is exactly the kind
      // of regression not worth risking to save one line. It does NOT
      // reintroduce NPAPI or any third-party plugin surface; that machinery
      // has been gone from Chromium for years, and `sandbox: true` and
      // `contextIsolation: true` both continue to apply.
      plugins: true,
    },
  });

  // Electron has no true headless mode. "Headless" here means the window is
  // shown OFF-SCREEN and without focus, rather than not shown at all.
  //
  // Never calling show() does hide it, but an unshown window never composites
  // a frame, so `page.screenshot()` hangs until it times out — which would
  // break every screenshot-capture harness. Showing it inactive at a
  // far-offscreen origin keeps compositing alive while keeping it off the
  // desktop and out of the focus order, so a test run stops stealing the
  // user's keyboard and flashing windows.
  const headless = process.env['POCKETSHELL_HEADLESS'] === '1';
  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) return;
    if (headless) {
      mainWindow.setPosition(-32000, -32000);
      mainWindow.showInactive();
    } else {
      mainWindow.show();
    }
  });

  // Open external links in the system browser, never in-app — and only if
  // they are web links.
  //
  // `shell.openExternal` hands the URL to the OS to dispatch by SCHEME, and
  // this handler used to pass whatever it was given. Two consequences, one
  // visible and one not:
  //
  //   - A click that produced no real URL still reached here as
  //     `about:blank` (that is what Electron reports when `window.open` has
  //     nothing usable), so Windows popped "We can't open this 'about'
  //     link — your device needs a new app to open this link".
  //   - More seriously, the renderer linkifies TERMINAL OUTPUT, which is
  //     bytes from a remote host. Anything that host can print, it could
  //     get handed to the OS shell: `file:`, `ms-`, a custom protocol
  //     registered by some other installed app. A remote box should not be
  //     able to pick which local program opens.
  //
  // So the scheme is allow-listed, parsing is guarded (a malformed URL
  // throws in the URL constructor rather than falling through), and
  // everything else is dropped with a log rather than silently ignored —
  // a link that does nothing at all is its own bug report.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) {
      void shell.openExternal(url);
    } else {
      console.warn('[pocketshell] refused to open non-web link:', url);
    }
    return { action: 'deny' };
  });

  // Zoom chords. Recognised here, DECIDED in the renderer.
  //
  // Two jobs, and they are inseparable. The first is to catch every spelling
  // of "zoom in" — Ctrl+=, Ctrl+Shift+=, a layout's dedicated +, the numeric
  // keypad's + — which is the reported bug: Electron's default menu binds
  // `CommandOrControl+Plus`, and `Plus` is SHIFTED `=`, so plain Ctrl+= hit
  // nothing while Ctrl+- and Ctrl+0 worked. See src/shared/zoomKeys.ts.
  //
  // The second is `preventDefault()`, which is load-bearing rather than
  // tidy-up: it suppresses the page's keydown AND the menu shortcut, and
  // suppressing the menu shortcut is what stops the default menu's zoom roles
  // driving Chromium's zoom directly, behind the settings store's back. With
  // them live, Ctrl+- would move the window without the store ever hearing
  // about it and the percentage in Settings would be a lie one keystroke
  // later. That is why the intent is forwarded rather than applied here: main
  // does not know the current zoom and must not guess it. The renderer's
  // settings store steps its own value, persists it, and applies it — one
  // value, one writer, no way for the two to disagree.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const command = zoomCommandForInput(input);
    if (!command) return;
    event.preventDefault();
    mainWindow?.webContents.send(ipc.win.zoomCommand, command);
  });

  // electron-vite: dev server URL in dev, built file in prod.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dir, '../renderer/index.html'));
  }
}

// Ensure only one instance of the app runs.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // A rejection here means no window and no error surfaced anywhere, so the
  // app would just look dead on launch. Log it and exit non-zero instead.
  app.whenReady().then(
    () => {
      registerIpcHandlers({
        registry,
        ssh,
        helper,
        sftp,
        forwards,
        projects,
        getWindows: () => BrowserWindow.getAllWindows(),
      });
      createWindow();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    },
    (err: unknown) => {
      console.error('[pocketshell] startup failed:', err);
      app.exit(1);
    },
  );
}

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  registry.clear();
  if (process.platform !== 'darwin') app.quit();
});

// Clean up all SSH connections on quit.
app.on('before-quit', () => {
  registry.clear();
});

/**
 * True only for `http:` and `https:`.
 *
 * Deliberately an allow-list rather than a deny-list of known-bad schemes:
 * the set of protocols an arbitrary Windows install has registered is
 * unknowable from here, so anything not explicitly a web link is refused.
 */
function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
