import { ipcMain, BrowserWindow } from 'electron';
import { ipc } from '../shared/channels.js';
import type { BootstrapResult, HostEntry, SessionSummary } from '../shared/types.js';
import { SshService } from './ssh/SshService.js';
import { ConnectionRegistry } from './ssh/ConnectionRegistry.js';
import { PocketshellClient } from './helper/PocketshellClient.js';
import { runBootstrap } from './helper/bootstrap.js';
import { readSshConfig } from './ssh-config/SshConfigParser.js';
import { KnownHosts } from './ssh-config/KnownHosts.js';
import type { UsageRow } from './helper/parsers.js';

/**
 * Registers all ipcMain handlers. Called once from the main process entry.
 *
 * Every privileged operation lives here. The renderer calls the typed
 * `window.api` surface exposed by the preload, which forwards to these
 * channels. Keys/passphrases never leave this module.
 *
 * Streaming events (terminal bytes, shell exit) are pushed to every
 * BrowserWindow via `webContents.send` — keyed by the shell id so the
 * renderer routes them to the right view.
 */
export function registerIpcHandlers(deps: {
  registry: ConnectionRegistry;
  ssh: SshService;
  helper: PocketshellClient;
  getWindows: () => BrowserWindow[];
}): void {
  const { registry, ssh, helper, getWindows } = deps;

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  // --- ssh:listConfigHosts -------------------------------------------------
  ipcMain.handle(ipc.ssh.listConfigHosts, async (): Promise<HostEntry[]> => {
    return readSshConfig();
  });

  // --- ssh:connect ---------------------------------------------------------
  ipcMain.handle(
    ipc.ssh.connect,
    async (
      _evt,
      payload: {
        host: string;
        port?: number;
        user: string;
        privateKeyPath?: string;
        privateKey?: string;
        passphrase?: string;
        tofuDecision?: 'accept-always' | 'accept-once' | 'reject';
      },
    ) => {
      const knownHosts = new KnownHosts();
      return ssh.connect({
        host: payload.host,
        port: payload.port,
        user: payload.user,
        privateKeyPath: payload.privateKeyPath,
        privateKey: payload.privateKey,
        passphrase: payload.passphrase,
        knownHosts,
        tofuDecision: payload.tofuDecision,
      });
    },
  );

  // --- ssh:exec ------------------------------------------------------------
  ipcMain.handle(ipc.ssh.exec, async (_evt, connectionId: string, command: string) => {
    return ssh.exec(connectionId, command);
  });

  // --- ssh:close -----------------------------------------------------------
  ipcMain.handle(ipc.ssh.close, async (_evt, connectionId: string) => {
    ssh.close(connectionId);
    return true;
  });

  // --- shell:open ----------------------------------------------------------
  // Opens a tracked PTY shell (optionally running a command like
  // `tmux attach -t main`) and streams stdout bytes back over
  // `shell:event:data`. The renderer feeds input via `shell:input`.
  // This is what powers the xterm.js terminal view.
  ipcMain.handle(
    ipc.shell.open,
    async (
      _evt,
      payload: { connectionId: string; command?: string; cols?: number; rows?: number },
    ) => {
      const shellId = await ssh.openTrackedShell(payload.connectionId, {
        command: payload.command,
        cols: payload.cols,
        rows: payload.rows,
        onData: (data: Buffer) => {
          // Copy into a fresh Uint8Array view so the structured-clone across
          // the IPC boundary does not detach the underlying ssh2 buffer.
          broadcast(ipc.shell.data, { shellId, data: new Uint8Array(data) });
        },
        onExit: (exitCode: number) => {
          broadcast(ipc.shell.exited, { shellId, exitCode });
        },
      });
      return shellId;
    },
  );

  // --- shell:input / resize / close ---------------------------------------
  ipcMain.handle(ipc.shell.input, async (_evt, shellId: string, data: string) => {
    ssh.shellInput(shellId, data);
    return true;
  });
  ipcMain.handle(ipc.shell.resize, async (_evt, shellId: string, cols: number, rows: number) => {
    ssh.shellResize(shellId, cols, rows);
    return true;
  });
  ipcMain.handle(ipc.shell.close, async (_evt, shellId: string) => {
    ssh.shellClose(shellId);
    return true;
  });

  // --- helper:bootstrap ----------------------------------------------------
  ipcMain.handle(ipc.helper.bootstrap, async (_evt, connectionId: string): Promise<BootstrapResult> => {
    return runBootstrap(ssh, connectionId);
  });

  // --- helper:sessionsList -------------------------------------------------
  ipcMain.handle(
    ipc.helper.sessionsList,
    async (
      _evt,
      connectionId: string,
      sortBy?: 'activity' | 'created',
    ): Promise<SessionSummary[]> => {
      return helper.listSessions(connectionId, sortBy ?? 'activity');
    },
  );

  // --- helper:sessionsCreate ----------------------------------------------
  ipcMain.handle(
    ipc.helper.sessionsCreate,
    async (_evt, connectionId: string, name: string, cwd?: string): Promise<boolean> => {
      return helper.createSession(connectionId, name, cwd);
    },
  );

  // --- helper:usage --------------------------------------------------------
  ipcMain.handle(ipc.helper.usage, async (_evt, connectionId: string): Promise<UsageRow[]> => {
    return helper.usage(connectionId);
  });

  // Plumbing: keep references used by the main process bookkeeping.
  void registry;
}
