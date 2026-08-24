import { ipcMain, BrowserWindow, dialog } from 'electron';
import { ipc } from '../shared/channels.js';
import type {
  AttachmentSource,
  BootstrapResult,
  HostEntry,
  SessionSummary,
  StageAttachmentsResult,
} from '../shared/types.js';
import { SshService } from './ssh/SshService.js';
import { ConnectionRegistry } from './ssh/ConnectionRegistry.js';
import { PocketshellClient } from './helper/PocketshellClient.js';
import { runBootstrap } from './helper/bootstrap.js';
import { readSshConfig } from './ssh-config/SshConfigParser.js';
import { KnownHosts } from './ssh-config/KnownHosts.js';
import type { UsageRow } from './helper/parsers.js';
import { SftpService, type DirEntry, type FileStat, type TransferProgress } from './sftp/SftpService.js';
import { ForwardService } from './portfwd/ForwardService.js';
import type { RemotePort } from './portfwd/PortScanner.js';
import type { ForwardSpec } from '../shared/types.js';
import { AttachmentStager } from './attachments/AttachmentStager.js';

/**
 * Registers all ipcMain handlers. Called once from the main process entry.
 *
 * Every privileged operation lives here. The renderer calls the typed
 * `window.api` surface exposed by the preload, which forwards to these
 * channels. Keys/passphrases never leave this module.
 *
 * Streaming events (terminal bytes, shell exit, transfer progress) are pushed
 * to every BrowserWindow via `webContents.send` — keyed by the relevant id.
 */
export function registerIpcHandlers(deps: {
  registry: ConnectionRegistry;
  ssh: SshService;
  helper: PocketshellClient;
  sftp: SftpService;
  forwards: ForwardService;
  getWindows: () => BrowserWindow[];
}): void {
  const { registry, ssh, helper, sftp, forwards, getWindows } = deps;

  // Prompt attachments ride the SSH/SFTP services that are already here —
  // no second connection, no shelling out to scp.
  const attachments = new AttachmentStager({ ssh, sftp });

  // Subscribe to forward-state changes and broadcast them to the renderer.
  forwards.onStates((connectionId, states) => {
    broadcast(ipc.forwards.states, { connectionId, states });
  });

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

  // --- sftp:* --------------------------------------------------------------
  // File operations over SFTP on the existing connection. Upload/download
  // stream progress back over `sftp:event:progress` keyed by a transferId the
  // renderer supplies so it can update the right progress bar.
  ipcMain.handle(
    ipc.sftp.list,
    async (_evt, connectionId: string, path: string): Promise<DirEntry[]> => {
      return sftp.list(connectionId, path);
    },
  );
  ipcMain.handle(
    ipc.sftp.stat,
    async (_evt, connectionId: string, path: string): Promise<FileStat> => {
      return sftp.stat(connectionId, path);
    },
  );
  ipcMain.handle(
    ipc.sftp.readFile,
    async (_evt, connectionId: string, path: string): Promise<string> => {
      return sftp.readFile(connectionId, path);
    },
  );
  ipcMain.handle(
    ipc.sftp.writeFile,
    async (_evt, connectionId: string, path: string, content: string): Promise<boolean> => {
      await sftp.writeFile(connectionId, path, content);
      return true;
    },
  );
  ipcMain.handle(ipc.sftp.mkdir, async (_evt, connectionId: string, path: string): Promise<boolean> => {
    await sftp.mkdir(connectionId, path);
    return true;
  });
  ipcMain.handle(
    ipc.sftp.rename,
    async (_evt, connectionId: string, fromPath: string, toPath: string): Promise<boolean> => {
      await sftp.rename(connectionId, fromPath, toPath);
      return true;
    },
  );
  ipcMain.handle(
    ipc.sftp.deleteFile,
    async (_evt, connectionId: string, path: string): Promise<boolean> => {
      await sftp.deleteFile(connectionId, path);
      return true;
    },
  );
  ipcMain.handle(ipc.sftp.rmdir, async (_evt, connectionId: string, path: string): Promise<boolean> => {
    await sftp.rmdir(connectionId, path);
    return true;
  });
  ipcMain.handle(
    ipc.sftp.realPath,
    async (_evt, connectionId: string, path: string): Promise<string> => {
      return sftp.realPath(connectionId, path);
    },
  );
  ipcMain.handle(
    ipc.sftp.upload,
    async (
      _evt,
      payload: { connectionId: string; localPath: string; remotePath: string; transferId: string },
    ): Promise<boolean> => {
      await sftp.upload(payload.connectionId, payload.localPath, payload.remotePath, (p: TransferProgress) => {
        broadcast(ipc.sftp.progress, { transferId: payload.transferId, ...p });
      });
      return true;
    },
  );
  ipcMain.handle(
    ipc.sftp.download,
    async (
      _evt,
      payload: { connectionId: string; remotePath: string; localPath: string; transferId: string },
    ): Promise<boolean> => {
      await sftp.download(payload.connectionId, payload.remotePath, payload.localPath, (p: TransferProgress) => {
        broadcast(ipc.sftp.progress, { transferId: payload.transferId, ...p });
      });
      return true;
    },
  );

  // --- forwards:* ---------------------------------------------------------
  // Port forwarding: scan remote listeners, start/stop the auto-forwarder,
  // and add/remove manual -L/-R/-D forwards. State snapshots stream over
  // `forwards:event:states` (subscribed above).
  ipcMain.handle(
    ipc.forwards.scan,
    async (_evt, connectionId: string): Promise<RemotePort[]> => {
      return forwards.scan(connectionId);
    },
  );
  ipcMain.handle(ipc.forwards.startAuto, async (_evt, connectionId: string): Promise<boolean> => {
    forwards.startAuto(connectionId);
    return true;
  });
  ipcMain.handle(ipc.forwards.stopAuto, async (_evt, connectionId: string): Promise<boolean> => {
    forwards.stopAuto(connectionId);
    return true;
  });
  ipcMain.handle(
    ipc.forwards.addManual,
    async (_evt, connectionId: string, spec: ForwardSpec): Promise<boolean> => {
      return forwards.addManual(connectionId, spec);
    },
  );
  ipcMain.handle(
    ipc.forwards.remove,
    async (_evt, connectionId: string, key: string): Promise<boolean> => {
      await forwards.remove(connectionId, key);
      return true;
    },
  );
  ipcMain.handle(ipc.forwards.list, async (_evt, connectionId: string) => {
    return forwards.list(connectionId);
  });

  // --- attachments:* ------------------------------------------------------
  // Prompt attachments: upload pasted bytes / picked files into
  // `~/.pocketshell/attachments/<scope>/` and hand back the remote paths the
  // composer splices into the prompt text (the agent reads them off disk).
  // Never rejects — a partial batch resolves with the survivors in `paths`
  // AND an `error` describing the shortfall (Android issue #570).
  ipcMain.handle(
    ipc.attachments.stage,
    async (
      _evt,
      payload: { connectionId: string; scopeKey: string; sources: AttachmentSource[] },
    ): Promise<StageAttachmentsResult> => {
      return attachments.stage(payload.connectionId, payload.scopeKey, payload.sources ?? []);
    },
  );

  // Native file picker. Lives on this side so the renderer never needs
  // filesystem access — it gets back opaque paths it can only hand to
  // `attachments:stage`.
  ipcMain.handle(
    ipc.attachments.pickFiles,
    async (_evt, payload?: { title?: string; multiple?: boolean }): Promise<string[]> => {
      const parent = getWindows().find((w) => !w.isDestroyed());
      const options: Electron.OpenDialogOptions = {
        title: payload?.title ?? 'Attach files',
        buttonLabel: 'Attach',
        properties:
          payload?.multiple === false
            ? ['openFile']
            : ['openFile', 'multiSelections'],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? [] : result.filePaths;
    },
  );

  // --- agent:* ------------------------------------------------------------
  // Agent-awareness: conversation logs, resumable conversations, profiles,
  // and the env editor — all delegated to the server-side pocketshell helper.
  ipcMain.handle(
    ipc.agent.log,
    async (
      _evt,
      connectionId: string,
      engine: 'claude' | 'codex' | 'opencode',
      session: string,
      cwd?: string,
    ) => {
      return helper.agentLog(connectionId, engine, session, cwd);
    },
  );
  ipcMain.handle(ipc.agent.resumable, async (_evt, connectionId: string) => {
    return helper.listResumable(connectionId, true);
  });
  ipcMain.handle(ipc.agent.profiles, async (_evt, connectionId: string) => {
    return helper.listProfiles(connectionId);
  });
  ipcMain.handle(
    ipc.agent.envList,
    async (_evt, connectionId: string, dir: string) => {
      return helper.envList(connectionId, dir);
    },
  );
  ipcMain.handle(ipc.agent.envGet, async (_evt, connectionId: string, dir: string) => {
    return helper.envGet(connectionId, dir);
  });

  // Plumbing: keep references used by the main process bookkeeping.
  void registry;
}
