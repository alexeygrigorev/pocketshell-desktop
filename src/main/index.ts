import { app, BrowserWindow, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionRegistry } from './ssh/ConnectionRegistry.js';
import { SshService } from './ssh/SshService.js';
import { PocketshellClient } from './helper/PocketshellClient.js';
import { SftpService } from './sftp/SftpService.js';
import { ForwardService } from './portfwd/ForwardService.js';
import { ProjectsService } from './projects/ProjectsService.js';
import { registerIpcHandlers } from './ipc.js';

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'PocketShell',
    webPreferences: {
      preload: join(__dir, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

  // Open external links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
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
