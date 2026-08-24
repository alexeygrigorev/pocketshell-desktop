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
import type { AutoForwarderStatus, DiscoveredPort } from './portfwd/AutoForwarder.js';
import type { PortIntent } from './portfwd/PortfwdStore.js';
import type { ForwardSpec } from '../shared/types.js';
import { AttachmentStager } from './attachments/AttachmentStager.js';
import { LocalFileReader, MAX_IMAGE_READ_BYTES } from './attachments/LocalFileReader.js';
import type {
  CloneResult,
  CreateFolderRequest,
  CreateFolderResult,
  HomeResult,
  ProjectsService,
  ReposCloneOptions,
  ReposListRequest,
  ReposListResult,
  StartSessionRequest,
  StartSessionResult,
} from './projects/ProjectsService.js';

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
  projects: ProjectsService;
  getWindows: () => BrowserWindow[];
}): void {
  const { registry, ssh, helper, sftp, forwards, projects, getWindows } = deps;

  // Prompt attachments ride the SSH/SFTP services that are already here —
  // no second connection, no shelling out to scp.
  const attachments = new AttachmentStager({ ssh, sftp });

  // The read-back side of the picker. Holds the allow-list of paths the
  // native dialog has handed the renderer this session — see
  // LocalFileReader for why `attachments:readLocal` needs one at all.
  const localFiles = new LocalFileReader();

  // Subscribe to forward-state changes and broadcast them to the renderer.
  forwards.onStates((connectionId, states) => {
    broadcast(ipc.forwards.states, { connectionId, states });
  });

  // Connection liveness. `ssh:event:state` was declared but nothing ever
  // emitted it, so a dropped link left the renderer showing `connected`
  // indefinitely — the composer could not tell the user a send would go
  // nowhere. 'lost' means the transport dropped; 'idle' is a clean
  // disconnect the user asked for.
  ssh.onCloseConnection((connectionId, reason) => {
    broadcast(ipc.ssh.state, {
      connectionId,
      state: reason === 'lost' ? 'lost' : 'idle',
    });
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
        /** `HostEntry.name` when the host came from ~/.ssh/config. */
        hostAlias?: string;
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
        hostAlias: payload.hostAlias,
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
  // Return what actually happened, not an unconditional true: the composer's
  // delivery-failure path depends on this being honest.
  ipcMain.handle(ipc.shell.input, async (_evt, shellId: string, data: string) =>
    ssh.shellInput(shellId, data),
  );
  ipcMain.handle(ipc.shell.resize, async (_evt, shellId: string, cols: number, rows: number) =>
    ssh.shellResize(shellId, cols, rows),
  );
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
  // Explicit-name create. The folder-first flow goes through
  // `projects:startSession`; this remains for a caller that genuinely knows
  // the tmux session name it wants (and it must supply the cwd — a session
  // with no start folder is not a project session).
  ipcMain.handle(
    ipc.helper.sessionsCreate,
    async (_evt, connectionId: string, name: string, cwd: string): Promise<boolean> => {
      const outcome = await helper.createSession(connectionId, { name, cwd });
      return outcome.ok;
    },
  );

  // --- helper:usage --------------------------------------------------------
  ipcMain.handle(ipc.helper.usage, async (_evt, connectionId: string): Promise<UsageRow[]> => {
    return helper.usage(connectionId);
  });

  // --- projects:* ----------------------------------------------------------
  // Folder-first session creation. The renderer browses folders with the SFTP
  // channels below (there is no second folder-listing path here on purpose);
  // these add the pieces SFTP cannot answer: where home is, what a folder's
  // session would be called, the repo list, the clone, and the create.
  ipcMain.handle(ipc.projects.home, async (_evt, connectionId: string): Promise<HomeResult> => {
    return projects.home(connectionId);
  });

  ipcMain.handle(
    ipc.projects.deriveName,
    async (_evt, connectionId: string, folder: string, customName?: string): Promise<string> => {
      return projects.deriveSessionName(connectionId, folder, customName);
    },
  );

  ipcMain.handle(
    ipc.projects.createFolder,
    async (
      _evt,
      connectionId: string,
      request: CreateFolderRequest,
    ): Promise<CreateFolderResult> => {
      return projects.createFolder(connectionId, request);
    },
  );

  ipcMain.handle(
    ipc.projects.reposList,
    async (
      _evt,
      connectionId: string,
      request?: ReposListRequest,
    ): Promise<ReposListResult> => {
      return projects.reposList(connectionId, request ?? {});
    },
  );

  // A clone can run for tens of seconds. The invoke still resolves with the
  // final result, but `projects:event:cloneProgress` fires immediately with
  // phase 'started' (and again on 'finished') so the UI has something to show
  // rather than looking hung — the same shape as sftp transfer progress.
  ipcMain.handle(
    ipc.projects.reposClone,
    async (
      _evt,
      connectionId: string,
      request: ReposCloneOptions & { requestId?: string },
    ): Promise<CloneResult> => {
      return projects.cloneRepo(connectionId, request, (progress) => {
        broadcast(ipc.projects.cloneProgress, progress);
      });
    },
  );

  ipcMain.handle(
    ipc.projects.startSession,
    async (
      _evt,
      connectionId: string,
      request: StartSessionRequest,
    ): Promise<StartSessionResult> => {
      return projects.startSession(connectionId, request);
    },
  );

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
  // The binary sibling of `sftp:readFile`, which decodes UTF-8 and so
  // cannot carry a PNG. Capped at the same ceiling as `attachments:readLocal`
  // because the bytes land identically: one Buffer here, one structured
  // clone in the renderer, one decoded bitmap on the canvas.
  ipcMain.handle(
    ipc.sftp.readBinary,
    async (_evt, connectionId: string, path: string): Promise<Uint8Array> => {
      const buffer = await sftp.readBinary(connectionId, path, MAX_IMAGE_READ_BYTES);
      // Copy into a fresh, exactly-sized Uint8Array before it crosses the
      // bridge — same reason as `shell:event:data`: a Buffer is a view
      // into Node's shared allocation pool and loses its prototype in the
      // structured clone regardless, so hand over the plain view.
      return new Uint8Array(buffer);
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
  // `configForwards` carries the host's `~/.ssh/config` `LocalForward` lines
  // (HostEntry.localForwards). They are opened once alongside the scan loop
  // and marked `origin: 'ssh-config'` so the panel can tell them from the
  // ports auto-discovery found. Omitted (or empty) keeps the old behaviour.
  ipcMain.handle(
    ipc.forwards.startAuto,
    async (_evt, connectionId: string, configForwards?: ForwardSpec[]): Promise<boolean> => {
      forwards.startAuto(connectionId, configForwards ?? []);
      return true;
    },
  );
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

  // Run one policy-applying scan pass now — what the panel's "Scan" button
  // calls. Unlike `forwards:scan` (which only lists) this opens and closes
  // forwards; a no-op when auto is not running.
  ipcMain.handle(ipc.forwards.refresh, async (_evt, connectionId: string): Promise<boolean> => {
    await forwards.refresh(connectionId);
    return true;
  });

  // Every port the last scan saw, annotated — including the ones policy
  // declined to forward, so the panel can offer them.
  ipcMain.handle(
    ipc.forwards.discovered,
    async (_evt, connectionId: string): Promise<DiscoveredPort[]> => {
      return forwards.discovered(connectionId);
    },
  );

  // Scan health, so the panel distinguishes "idle" from "scan failing".
  // Null means no forwarder is running for this connection.
  ipcMain.handle(
    ipc.forwards.status,
    async (_evt, connectionId: string): Promise<AutoForwarderStatus | null> => {
      return forwards.status(connectionId);
    },
  );

  // Friendly name for a remote port. A null/blank name deletes it. Persisted
  // per host, so it survives reconnect and restart.
  ipcMain.handle(
    ipc.forwards.setName,
    async (
      _evt,
      connectionId: string,
      remotePort: number,
      name: string | null,
    ): Promise<boolean> => {
      forwards.setName(connectionId, remotePort, name);
      return true;
    },
  );

  // Pin a remote port to a specific local port (persisted per host).
  ipcMain.handle(
    ipc.forwards.setRemap,
    async (
      _evt,
      connectionId: string,
      remotePort: number,
      localPort: number,
    ): Promise<boolean> => {
      await forwards.setRemap(connectionId, remotePort, localPort);
      return true;
    },
  );

  // Drop a pin, returning the port to mirror-then-allocate resolution.
  ipcMain.handle(
    ipc.forwards.clearRemap,
    async (_evt, connectionId: string, remotePort: number): Promise<boolean> => {
      await forwards.clearRemap(connectionId, remotePort);
      return true;
    },
  );

  // Force a port on, off, or (null) back to the automatic policy. Persisted.
  ipcMain.handle(
    ipc.forwards.setIntent,
    async (
      _evt,
      connectionId: string,
      remotePort: number,
      intent: PortIntent | null,
    ): Promise<boolean> => {
      await forwards.setIntent(connectionId, remotePort, intent);
      return true;
    },
  );

  // Flip a remote port between forwarded and silenced, persisting whichever
  // intent the flip landed on.
  ipcMain.handle(
    ipc.forwards.togglePort,
    async (_evt, connectionId: string, remotePort: number): Promise<boolean> => {
      await forwards.togglePort(connectionId, remotePort);
      return true;
    },
  );

  // Whether auto-forward was left enabled for this connection's host — the
  // panel restores its toggle from this on connect.
  ipcMain.handle(
    ipc.forwards.isAutoEnabled,
    async (_evt, connectionId: string): Promise<boolean> => {
      return forwards.isAutoEnabled(connectionId);
    },
  );

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
  // filesystem access — it gets back paths it can hand to
  // `attachments:stage` or, since the doodle editor, read back through
  // `attachments:readLocal`. Every returned path is recorded as the
  // allow-list for that read.
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
      const paths = result.canceled ? [] : result.filePaths;
      localFiles.remember(paths);
      return paths;
    },
  );

  // Read a picked file's BYTES back into the renderer, so it can be drawn
  // on before anything is uploaded. This is the one place the renderer
  // gets a filesystem read, which is why it is not `readFile(path)`: the
  // reader serves only paths the native dialog handed out in this
  // session, and refuses everything else. See LocalFileReader.
  //
  // Rejects on refusal / missing file / not-a-file / oversize, matching
  // `sftp:readFile` rather than `attachments:stage` — one file, so there
  // is no partial-batch outcome to encode in a result object.
  ipcMain.handle(
    ipc.attachments.readLocal,
    async (_evt, path: string): Promise<Uint8Array> => {
      return new Uint8Array(await localFiles.read(path));
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
  // `keys` is optional: omit it to reveal the folder's whole env (the helper
  // needs `env list` first, since `env get` has no "all keys" mode).
  ipcMain.handle(
    ipc.agent.envGet,
    async (_evt, connectionId: string, dir: string, keys?: string[]) => {
      return helper.envGet(connectionId, dir, keys);
    },
  );

  // Plumbing: keep references used by the main process bookkeeping.
  void registry;
}
