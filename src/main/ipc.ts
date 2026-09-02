import { ipcMain, BrowserWindow, app, dialog, shell } from 'electron';
import { ipc } from '../shared/channels.js';
import { APP_TITLE } from '../shared/windowTitle.js';
import type {
  AttachmentSource,
  BootstrapResult,
  HostEntry,
  SessionSummary,
  StageAttachmentsResult,
} from '../shared/types.js';
import { SshService } from './ssh/SshService.js';
import { ConnectionRegistry } from './ssh/ConnectionRegistry.js';
import { TmuxClientPool } from './ssh/TmuxClientPool.js';
import { PocketshellClient } from './helper/PocketshellClient.js';
import { runBootstrap } from './helper/bootstrap.js';
import { checkForUpdate } from './update/ReleaseChecker.js';
import { readSshConfig } from './ssh-config/SshConfigParser.js';
import { KnownHosts } from './ssh-config/KnownHosts.js';
import type { UsageRow } from './helper/parsers.js';
import { log } from './log.js';
import { SftpService, type DirEntry, type FileStat, type TransferProgress } from './sftp/SftpService.js';
import { ForwardService } from './portfwd/ForwardService.js';
import { ServeService, type ServedFolder } from './portfwd/ServeService.js';
import type { HtmlPreviewService } from './preview/HtmlPreviewService.js';
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
  KillSessionResult,
  RenameSessionResult,
  StartSessionRequest,
  StartSessionResult,
} from './projects/ProjectsService.js';

/**
 * The hard ceiling on `sftp:readBinary`, whatever the renderer asks for.
 *
 * The per-call `maxBytes` is a policy the CALLER owns (an image and an audio
 * file have very different sensible limits), but the cost of a read lands
 * here: the bytes are buffered in main, structured-cloned across the bridge,
 * and held again in the renderer. 128 MiB is the point past which that triple
 * is no longer something to do inside a click handler, and a file over it
 * belongs in `sftp:saveAs` — a streamed `fastGet` straight to disk that never
 * materialises in either process.
 */
const MAX_SFTP_READ_BYTES = 128 * 1024 * 1024;

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
  preview: HtmlPreviewService;
  getWindows: () => BrowserWindow[];
}): void {
  const { registry, ssh, helper, sftp, forwards, projects, preview, getWindows } = deps;

  // Prompt attachments ride the SSH/SFTP services that are already here —
  // no second connection, no shelling out to scp.
  const attachments = new AttachmentStager({ ssh, sftp });

  // The read-back side of the picker. Holds the allow-list of paths the
  // native dialog has handed the renderer this session — see
  // LocalFileReader for why `attachments:readLocal` needs one at all.
  const localFiles = new LocalFileReader();

  // One attached tmux client per visited session tab. Returning to a tab is a
  // renderer visibility change rather than a fresh SSH channel + login shell +
  // join. The helper rides along so the pool can locate each session's tmux
  // server at join time — the aiming its redraw and geometry probe need on
  // hosts where tmuxctl puts every session on its own server.
  const tmuxClients = new TmuxClientPool(ssh, helper);

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
    // The pooled tmux clients die with their connection; forgetting them here
    // stops a reconnect that reuses the id from handing out clients that are
    // no longer on the other end.
    tmuxClients.release(connectionId);
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

  // --- win:setTitle --------------------------------------------------------
  // The OS window title mirrors the VIEW — "PocketShell" on the picker, the
  // host's identity in the workspace — which is why the renderer drives it
  // rather than main deriving it from connection events: a connection outlives
  // the workspace view (Back keeps the link alive), so main cannot know which
  // screen the window is showing. The string is built by the shared pure
  // windowTitle(); this side only validates and applies it.
  ipcMain.on(ipc.win.setTitle, (evt, title: unknown) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win || win.isDestroyed()) return;
    win.setTitle(typeof title === 'string' && title.trim() ? title : APP_TITLE);
  });

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

  // --- shell:attachSession -------------------------------------------------
  // How a session tab gets its PTY. Unlike `shell:open` this may hand back a
  // PTY the renderer is already bound to: the pool keeps one tmux client per
  // session tab and holds it for the life of the tab, so a tab that is already
  // open is answered with its existing shell and no host work at all.
  // `switched` tells the renderer which of the two happened — true means "this
  // is the shell you already have, leave your terminal alone".
  ipcMain.handle(
    ipc.shell.attachSession,
    async (
      _evt,
      payload: { connectionId: string; sessionName: string; cols?: number; rows?: number },
    ) => {
      return tmuxClients.attach(payload.connectionId, payload.sessionName, {
        cols: payload.cols,
        rows: payload.rows,
        onData: (shellId, data) => {
          broadcast(ipc.shell.data, { shellId, data: new Uint8Array(data) });
        },
        onExit: (shellId, exitCode) => {
          broadcast(ipc.shell.exited, { shellId, exitCode });
        },
      });
    },
  );

  // --- shell:input / resize / close ---------------------------------------
  // Return what actually happened, not an unconditional true: the composer's
  // delivery-failure path depends on this being honest.
  // `sessionName` is optional and is a FENCE, not a target: it says which tmux
  // session the caller believed it was writing to. It was built when one PTY
  // served every session on a connection, where a multi-step write that
  // straddled a session change — the composer's text-pause-Enter, above all —
  // would finish in whatever session the pane had switched to. A PTY is now
  // bound to one session for its whole life, so that race is gone and this
  // check has become an assertion about a STALE id instead: a composer still
  // holding the shell of a tab that was evicted and re-joined. It still turns
  // into an honest `false`, which the composer already reports as a delivery
  // failure. Callers with nothing to be confused about (terminal keystrokes,
  // which always mean the pane as it is now) leave it off.
  ipcMain.handle(
    ipc.shell.input,
    async (_evt, shellId: string, data: string, sessionName?: string) => {
      if (sessionName && !tmuxClients.isShowing(shellId, sessionName)) return false;
      return ssh.shellInput(shellId, data);
    },
  );
  ipcMain.handle(ipc.shell.resize, async (_evt, shellId: string, cols: number, rows: number) =>
    ssh.shellResize(shellId, cols, rows),
  );
  // A repaint, not a resize. The renderer asks for this after it has made the
  // far end's idea of our geometry true again — see TerminalView's
  // `pushGeometry`, and TmuxClientPool.redraw for why tmux will not do it on
  // its own. False means "nothing to refresh", never an error.
  ipcMain.handle(ipc.shell.redraw, async (_evt, shellId: string) =>
    tmuxClients.redraw(shellId),
  );
  // The read-only question `redraw` exists to answer. Null means "no tmux
  // client behind this shell to ask" — a bare shell, an evicted tab — which is
  // an ordinary answer the renderer's reconcile loop treats as "nothing to
  // check", never as a failure.
  ipcMain.handle(ipc.shell.windowSize, async (_evt, shellId: string) =>
    tmuxClients.windowSize(shellId),
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

  // A rename is two operations, not one: the host renames the tmux session,
  // and the pool's note of which session its client is showing has to move
  // with it. Doing the second here rather than in the service keeps the
  // service free of the pool, and there is nowhere else both facts are in
  // scope. See TmuxClientPool.renamed for what breaks if it is skipped.
  ipcMain.handle(
    ipc.projects.renameSession,
    async (
      _evt,
      connectionId: string,
      from: string,
      to: string,
    ): Promise<RenameSessionResult> => {
      const result = await projects.renameSession(connectionId, from, to);
      if (result.ok && result.sessionName) {
        tmuxClients.renamed(connectionId, from, result.sessionName);
      }
      return result;
    },
  );

  // A kill is two operations for the same reason a rename is, and the pool half
  // matters MORE here: a rename leaves a live client pointing at a live session
  // under the wrong key, whereas a kill leaves one pointing at nothing at all.
  // Done here rather than in the service so the service stays free of the pool.
  //
  // The pool is told even when the host says the session was already gone. That
  // is the ordinary race — the tab bar refreshes on a timer — and our record of
  // a session that has been dead for some seconds is exactly the record that
  // needs dropping. See TmuxClientPool.killed.
  ipcMain.handle(
    ipc.projects.killSession,
    async (_evt, connectionId: string, name: string): Promise<KillSessionResult> => {
      const result = await projects.killSession(connectionId, name);
      if (result.ok || result.code === 'not-found') tmuxClients.killed(connectionId, name);
      return result;
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
  // cannot carry a PNG. Every Files-tab open now comes through here rather
  // than through `sftp:readFile`, because deciding whether bytes are text is
  // something only the caller that has LOOKED at them can do.
  //
  // The caller names its own ceiling, because the ceilings differ by an order
  // of magnitude and for a reason: an image is capped by the bitmap it
  // decodes to (32 MiB of JPEG is a great deal more than 32 MiB of pixels),
  // while audio is capped only by the copy across this bridge. What is NOT
  // negotiable is that a ceiling exists — an absent or absurd `maxBytes`
  // falls back to the image ceiling, and nothing is allowed above
  // MAX_SFTP_READ_BYTES no matter what the renderer asks for.
  ipcMain.handle(
    ipc.sftp.readBinary,
    async (_evt, connectionId: string, path: string, maxBytes?: number): Promise<Uint8Array> => {
      const requested =
        typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
          ? maxBytes
          : MAX_IMAGE_READ_BYTES;
      const buffer = await sftp.readBinary(
        connectionId,
        path,
        Math.min(requested, MAX_SFTP_READ_BYTES),
      );
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

  // `sftp:download` with the destination chosen by the user instead of
  // supplied by the caller. The Files tab needs this and cannot build it
  // itself: a sandboxed renderer has no filesystem and therefore no way to
  // name a local path, so the dialog has to live on this side — the same
  // reason `attachments:pickFiles` does.
  //
  // This is the only action the binary panel offers, which makes it the thing
  // that keeps "I will not render this" from being a dead end. Returns the
  // path written, or null when the user cancelled — cancelling is an outcome,
  // not an error.
  ipcMain.handle(
    ipc.sftp.saveAs,
    async (_evt, payload: { connectionId: string; remotePath: string }): Promise<string | null> => {
      const parent = getWindows().find((w) => !w.isDestroyed());
      const options: Electron.SaveDialogOptions = {
        title: 'Save file',
        defaultPath: payload.remotePath.split('/').pop() || 'download',
      };
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      await sftp.download(payload.connectionId, payload.remotePath, result.filePath);
      return result.filePath;
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

  // --- serve:* -------------------------------------------------------------
  // "Serve this folder". Built on `ssh` and `forwards` — which are already
  // here — so it is CONSTRUCTED here rather than in index.ts: it subscribes to
  // `onCloseConnection` itself (exactly like ForwardService), so there is
  // nothing for the entry point to remember to wire, and no second owner of
  // the tunnel machinery.
  const serve = new ServeService(ssh, forwards);
  serve.onChanged((connectionId, served) => {
    broadcast(ipc.serve.changed, { connectionId, served });
  });
  // Rejects with a message written to be shown verbatim (ServeError). Nothing
  // here resolves for a server that is not listening or a tunnel that is not
  // open — both are waited for in the service.
  ipcMain.handle(
    ipc.serve.start,
    async (_evt, connectionId: string, dir: string): Promise<ServedFolder> => {
      return serve.start(connectionId, dir);
    },
  );
  ipcMain.handle(
    ipc.serve.stop,
    async (_evt, connectionId: string, remotePort: number): Promise<boolean> => {
      await serve.stop(connectionId, remotePort);
      return true;
    },
  );
  ipcMain.handle(ipc.serve.list, async (_evt, connectionId: string): Promise<ServedFolder[]> => {
    return serve.list(connectionId);
  });

  // --- preview:* -----------------------------------------------------------
  // The Files tab's HTML preview. `openHtml` hands the renderer a URL on the
  // `psview:` scheme and nothing else — no bytes, no directory listing, no way
  // to widen the root — and `release` takes it back. Everything the URL can
  // reach is bounded in HtmlPreviewService, which is where the reasoning about
  // an untrusted remote document naming paths for us to read lives.
  ipcMain.handle(
    ipc.preview.openHtml,
    async (_evt, connectionId: string, path: string): Promise<{ token: string; url: string }> => {
      return preview.open(connectionId, path);
    },
  );
  // Markdown takes the app's palette as well as the path, because the document
  // is BUILT here (src/main/preview/markdownDocument.ts) rather than read off
  // the host, and only the renderer knows which theme is applied. The payload
  // is typed `unknown` on the way in and validated in the service — a preload
  // is not a trust boundary, and a value from this bridge ends up inside a
  // `<style>` block.
  ipcMain.handle(
    ipc.preview.openMarkdown,
    async (
      _evt,
      connectionId: string,
      path: string,
      style: { palette?: unknown; appearance?: unknown } | null,
    ): Promise<{ token: string; url: string }> => {
      return preview.openMarkdown(connectionId, path, style ?? {});
    },
  );
  // `send`, not `invoke`, on the renderer side: releasing is fire-and-forget
  // and happens on the way out of a file, where awaiting an IPC round trip
  // would put a hop inside a close handler for no observable benefit.
  ipcMain.on(ipc.preview.release, (_evt, token: unknown) => {
    if (typeof token === 'string') preview.release(token);
  });
  preview.setStatsListener((stats) => broadcast(ipc.preview.stats, stats));

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
  // Agent-awareness: profiles and the env editor, delegated to the
  // server-side pocketshell helper. The conversation-log and resumable
  // channels that used to live here went with the Conversation feature
  //
  // Null, not [], when the host could not be asked — the launch picker uses
  // the difference to decide whether an engine it cannot confirm should be
  // offered anyway (shared/agentLaunch.ts).
  ipcMain.handle(ipc.agent.kinds, async (_evt, connectionId: string) => {
    return helper.agentSubcommands(connectionId);
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
  // A write, so unlike the two readers it REJECTS on failure — the panel must
  // be able to tell "the helper refused" from "done". `helper.envSet` carries
  // the values to the command's stdin as one JSON object; they never touch
  // argv.
  ipcMain.handle(
    ipc.agent.envSet,
    async (
      _evt,
      connectionId: string,
      dir: string,
      values: Record<string, string>,
      file?: string,
    ) => {
      return helper.envSet(connectionId, dir, values, file);
    },
  );

  // --- diag:log -------------------------------------------------------------
  // The renderer's unhandled errors, forwarded so they land in the desktop log
  // a packaged app leaves nothing else of. Fire-and-forget (`on`, not
  // `handle`): a diagnostic that could block or reject in the process that
  // reported it would be a failure with a failure of its own.
  ipcMain.on(
    ipc.diag.log,
    (_evt, entry: { kind: string; message: string; stack?: string; detail?: Record<string, unknown> }) => {
      // The structured detail (parse-stall reports, first of all) IS the
      // diagnosis; the stack is the other shape a report can take. Either or
      // both may be present.
      const data: Record<string, unknown> = { ...(entry.detail ?? {}) };
      if (entry.stack) data.stack = entry.stack;
      log('renderer', `${entry.kind}: ${entry.message}`, Object.keys(data).length > 0 ? data : undefined);
    },
  );

  // --- update:check / update:open -------------------------------------------
  // The phone's ReleaseChecker, ported: one GitHub Releases poll per check,
  // answered as available / up-to-date / failed — never a thrown error,
  // because the caller is a banner. The download itself stays the user's
  // act: `open` sends the URL to the system browser, nothing self-installs.
  ipcMain.handle(ipc.update.check, () =>
    checkForUpdate({
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      fetcher: fetch,
    }),
  );
  ipcMain.handle(ipc.update.open, (_evt, url: string) => {
    // openExternal is the one call that leaves the app with a URL, so it
    // only ever fires for THIS repo's release assets and pages. Anything
    // else is logged and refused, not opened.
    const allowed =
      /^https:\/\/github\.com\/alexeygrigorev\/pocketshell-desktop\/(releases|releases\/download)\//;
    if (typeof url !== 'string' || !allowed.test(url)) {
      log('update', `refused to open non-release URL: ${String(url).slice(0, 120)}`);
      return;
    }
    return shell.openExternal(url);
  });

  // Plumbing: keep references used by the main process bookkeeping.
  void registry;
}
