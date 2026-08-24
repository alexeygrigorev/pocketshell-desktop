import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { ipc } from '../shared/channels.js';
import type {
  AttachmentSource,
  BootstrapResult,
  ConnectionState,
  ConnectResult,
  ExecResult,
  HostEntry,
  SessionSummary,
  ShellId,
  StageAttachmentsResult,
} from '../shared/types.js';
import type { UsageRow } from '../main/helper/parsers.js';
import type { DirEntry, FileStat, TransferProgress } from '../main/sftp/SftpService.js';
import type { RemotePort } from '../main/portfwd/PortScanner.js';
import type { ForwardState } from '../main/portfwd/Forwarder.js';
import type { ForwardSpec } from '../shared/types.js';
import type {
  CloneProgress,
  CloneResult,
  CreateFolderRequest,
  CreateFolderResult,
  HomeResult,
  ReposCloneOptions,
  ReposListRequest,
  ReposListResult,
  StartSessionRequest,
  StartSessionResult,
} from '../main/projects/ProjectsService.js';

/**
 * The typed API surface exposed to the renderer as `window.api`.
 *
 * The renderer is sandboxed (contextIsolation: true, nodeIntegration: false),
 * so this is the ONLY way it can reach the main process. No Node primitives,
 * no ssh2, no filesystem, no keys ever cross this bridge — only the typed
 * values in src/shared/types.ts.
 */

/** Listener deregistrator returned by event subscriptions. */
export type Unsubscribe = () => void;

const api = {
  ssh: {
    /** Read ~/.ssh/config into HostEntry rows. Empty if no config. */
    listConfigHosts: (): Promise<HostEntry[]> => ipcRenderer.invoke(ipc.ssh.listConfigHosts),

    /** Connect; resolves a ConnectResult (never rejects). */
    connect: (payload: {
      host: string;
      port?: number;
      user: string;
      privateKeyPath?: string;
      privateKey?: string;
      passphrase?: string;
      tofuDecision?: 'accept-always' | 'accept-once' | 'reject';
    }): Promise<ConnectResult> => ipcRenderer.invoke(ipc.ssh.connect, payload),

    /** Execute a command; no throw on non-zero exit. */
    exec: (connectionId: string, command: string): Promise<ExecResult> =>
      ipcRenderer.invoke(ipc.ssh.exec, connectionId, command),

    /** Close a connection. */
    close: (connectionId: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.ssh.close, connectionId),

    /**
     * Subscribe to connection-state changes. Fires `'lost'` when the
     * transport drops underneath us and `'idle'` on a clean disconnect, so
     * the UI can distinguish "your link died" from "you clicked disconnect".
     * Returns an unsubscribe function.
     */
    onState: (
      listener: (payload: { connectionId: string; state: ConnectionState }) => void,
    ): (() => void) => {
      const handler = (
        _e: unknown,
        payload: { connectionId: string; state: ConnectionState },
      ): void => listener(payload);
      ipcRenderer.on(ipc.ssh.state, handler);
      return () => ipcRenderer.removeListener(ipc.ssh.state, handler);
    },
  },

  shell: {
    /**
     * Open a tracked PTY shell (optionally running a command like
     * `tmux attach -t main`). Stdout bytes arrive via onShellData; the
     * returned ShellId addresses the shell for input/resize/close.
     */
    open: (payload: {
      connectionId: string;
      command?: string;
      cols?: number;
      rows?: number;
    }): Promise<ShellId> => ipcRenderer.invoke(ipc.shell.open, payload),

    /** Write input bytes to a shell's stdin (xterm.js -> remote). */
    input: (shellId: ShellId, data: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.shell.input, shellId, data),

    /** Resize a shell's PTY. */
    resize: (shellId: ShellId, cols: number, rows: number): Promise<boolean> =>
      ipcRenderer.invoke(ipc.shell.resize, shellId, cols, rows),

    /** Close a shell. */
    close: (shellId: ShellId): Promise<boolean> => ipcRenderer.invoke(ipc.shell.close, shellId),

    /** Subscribe to terminal stdout bytes. Returns an unsubscribe fn. */
    onData: (handler: (payload: { shellId: ShellId; data: Uint8Array }) => void): Unsubscribe => {
      const listener = (_evt: IpcRendererEvent, payload: { shellId: ShellId; data: Uint8Array }) =>
        handler(payload);
      ipcRenderer.on(ipc.shell.data, listener);
      return () => ipcRenderer.removeListener(ipc.shell.data, listener);
    },

    /** Subscribe to shell-exit events. Returns an unsubscribe fn. */
    onExited: (handler: (payload: { shellId: ShellId; exitCode: number }) => void): Unsubscribe => {
      const listener = (
        _evt: IpcRendererEvent,
        payload: { shellId: ShellId; exitCode: number },
      ) => handler(payload);
      ipcRenderer.on(ipc.shell.exited, listener);
      return () => ipcRenderer.removeListener(ipc.shell.exited, listener);
    },
  },

  helper: {
    /** Run the bootstrap probe (pocketshell / tmux / installer / daemon). */
    bootstrap: (connectionId: string): Promise<BootstrapResult> =>
      ipcRenderer.invoke(ipc.helper.bootstrap, connectionId),

    /** List live tmux sessions. */
    sessionsList: (
      connectionId: string,
      sortBy?: 'activity' | 'created',
    ): Promise<SessionSummary[]> =>
      ipcRenderer.invoke(ipc.helper.sessionsList, connectionId, sortBy),

    /**
     * Create a detached tmux session under an EXPLICIT name.
     *
     * Prefer `projects.startSession` — it derives the name from the folder the
     * way the phone and `tmuxctl` do, so all three clients agree on which
     * session belongs to which folder. Use this only when the exact tmux name
     * is already known.
     */
    sessionsCreate: (connectionId: string, name: string, cwd: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.helper.sessionsCreate, connectionId, name, cwd),

    /** Provider usage/quota rows. */
    usage: (connectionId: string): Promise<UsageRow[]> =>
      ipcRenderer.invoke(ipc.helper.usage, connectionId),
  },

  /**
   * Project-folder-first session creation.
   *
   * Three routes, one destination: pick an EXISTING folder, create a NEW empty
   * one, or CLONE a GitHub repo — then `startSession` on the resulting path.
   * The session name is derived from the folder, never typed.
   *
   * Browsing for the existing folder uses the `sftp` surface above:
   * `projects.home()` for the starting point, then `sftp.list(path)` filtered
   * to `type === 'dir'`.
   */
  projects: {
    /** Resolve the remote `$HOME` — the browse root and the name-derivation input. */
    home: (connectionId: string): Promise<HomeResult> =>
      ipcRenderer.invoke(ipc.projects.home, connectionId),

    /**
     * Preview the session name a folder would get (`~/git/pocketshell` ->
     * `git-pocketshell`). Base name only — no `-2` suffix, which only the host
     * can decide at create time.
     */
    deriveName: (connectionId: string, folder: string, customName?: string): Promise<string> =>
      ipcRenderer.invoke(ipc.projects.deriveName, connectionId, folder, customName),

    /** Create a new empty project folder and get back its canonical path. */
    createFolder: (
      connectionId: string,
      request: CreateFolderRequest,
    ): Promise<CreateFolderResult> =>
      ipcRenderer.invoke(ipc.projects.createFolder, connectionId, request),

    /**
     * Local clones + the user's GitHub repos, merged by `fullName`.
     *
     * A host with no `gh`, or one that is not logged in, is a NORMAL state:
     * `remote.state` says which, `remote.repos` is empty, and the local list
     * is unaffected. Show a hint, not an error.
     */
    reposList: (connectionId: string, request?: ReposListRequest): Promise<ReposListResult> =>
      ipcRenderer.invoke(ipc.projects.reposList, connectionId, request),

    /**
     * Clone a GitHub repo. Slow — subscribe with `onCloneProgress` and pass a
     * `requestId` to correlate the started/finished events. An already-cloned
     * target resolves `{ ok: true, alreadyExists: true }` with its path, so the
     * caller can go straight on to `startSession`.
     */
    reposClone: (
      connectionId: string,
      request: ReposCloneOptions & { requestId?: string },
    ): Promise<CloneResult> => ipcRenderer.invoke(ipc.projects.reposClone, connectionId, request),

    /**
     * Start (or re-open) the session for a folder. Idempotent by default:
     * `reused: true` means a session for this folder was already open.
     * Pass `namePolicy: 'unique'` for a deliberate second session.
     */
    startSession: (
      connectionId: string,
      request: StartSessionRequest,
    ): Promise<StartSessionResult> =>
      ipcRenderer.invoke(ipc.projects.startSession, connectionId, request),

    /** Subscribe to clone lifecycle events. Returns an unsubscribe fn. */
    onCloneProgress: (handler: (progress: CloneProgress) => void): Unsubscribe => {
      const listener = (_evt: IpcRendererEvent, progress: CloneProgress) => handler(progress);
      ipcRenderer.on(ipc.projects.cloneProgress, listener);
      return () => ipcRenderer.removeListener(ipc.projects.cloneProgress, listener);
    },
  },

  sftp: {
    /** List directory entries. */
    list: (connectionId: string, path: string): Promise<DirEntry[]> =>
      ipcRenderer.invoke(ipc.sftp.list, connectionId, path),

    /** Stat a path. Rejects if it does not exist. */
    stat: (connectionId: string, path: string): Promise<FileStat> =>
      ipcRenderer.invoke(ipc.sftp.stat, connectionId, path),

    /** Read a file as UTF-8 text. */
    readFile: (connectionId: string, path: string): Promise<string> =>
      ipcRenderer.invoke(ipc.sftp.readFile, connectionId, path),

    /** Write UTF-8 text to a file (overwrites). */
    writeFile: (connectionId: string, path: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.sftp.writeFile, connectionId, path, content),

    /** Create a directory. */
    mkdir: (connectionId: string, path: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.sftp.mkdir, connectionId, path),

    /** Rename/move a path. */
    rename: (connectionId: string, fromPath: string, toPath: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.sftp.rename, connectionId, fromPath, toPath),

    /** Delete a file. */
    deleteFile: (connectionId: string, path: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.sftp.deleteFile, connectionId, path),

    /** Remove an empty directory. */
    rmdir: (connectionId: string, path: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.sftp.rmdir, connectionId, path),

    /** Resolve a path to its absolute form (follows symlinks). */
    realPath: (connectionId: string, path: string): Promise<string> =>
      ipcRenderer.invoke(ipc.sftp.realPath, connectionId, path),

    /** Upload a local file to a remote path, streaming progress. */
    upload: (payload: {
      connectionId: string;
      localPath: string;
      remotePath: string;
      transferId: string;
    }): Promise<boolean> => ipcRenderer.invoke(ipc.sftp.upload, payload),

    /** Download a remote file to a local path, streaming progress. */
    download: (payload: {
      connectionId: string;
      remotePath: string;
      localPath: string;
      transferId: string;
    }): Promise<boolean> => ipcRenderer.invoke(ipc.sftp.download, payload),

    /** Subscribe to transfer-progress events. Returns an unsubscribe fn. */
    onProgress: (
      handler: (payload: { transferId: string } & TransferProgress) => void,
    ): Unsubscribe => {
      const listener = (
        _evt: IpcRendererEvent,
        payload: { transferId: string } & TransferProgress,
      ) => handler(payload);
      ipcRenderer.on(ipc.sftp.progress, listener);
      return () => ipcRenderer.removeListener(ipc.sftp.progress, listener);
    },
  },

  forwards: {
    /** One-shot remote port scan. */
    scan: (connectionId: string): Promise<RemotePort[]> =>
      ipcRenderer.invoke(ipc.forwards.scan, connectionId),

    /** Start the auto-forwarder for a connection. */
    startAuto: (connectionId: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.startAuto, connectionId),

    /** Stop the auto-forwarder for a connection. */
    stopAuto: (connectionId: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.stopAuto, connectionId),

    /** Add a manual -L/-R/-D forward. */
    addManual: (connectionId: string, spec: ForwardSpec): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.addManual, connectionId, spec),

    /** Remove a forward by its key. */
    remove: (connectionId: string, key: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.remove, connectionId, key),

    /** Current snapshot for a connection. */
    list: (connectionId: string): Promise<ForwardState[]> =>
      ipcRenderer.invoke(ipc.forwards.list, connectionId),

    /** Subscribe to forward-state snapshots. Returns an unsubscribe fn. */
    onStates: (
      handler: (payload: { connectionId: string; states: ForwardState[] }) => void,
    ): Unsubscribe => {
      const listener = (
        _evt: IpcRendererEvent,
        payload: { connectionId: string; states: ForwardState[] },
      ) => handler(payload);
      ipcRenderer.on(ipc.forwards.states, listener);
      return () => ipcRenderer.removeListener(ipc.forwards.states, listener);
    },
  },

  attachments: {
    /**
     * Upload pasted bytes and/or picked files into
     * `~/.pocketshell/attachments/<scope>/` and get back the remote paths
     * to splice into the prompt text.
     *
     * Never rejects. On a partial batch `ok` is false but `paths` still
     * holds the files that DID upload — attach those and show `error`.
     */
    stage: (payload: {
      connectionId: string;
      scopeKey: string;
      sources: AttachmentSource[];
    }): Promise<StageAttachmentsResult> => ipcRenderer.invoke(ipc.attachments.stage, payload),

    /** Open the native file picker; resolves [] if the user cancelled. */
    pickFiles: (payload?: { title?: string; multiple?: boolean }): Promise<string[]> =>
      ipcRenderer.invoke(ipc.attachments.pickFiles, payload),
  },

  agent: {
    /** Read an agent conversation log (raw JSONL envelope). */
    log: (
      connectionId: string,
      engine: 'claude' | 'codex' | 'opencode',
      session: string,
      cwd?: string,
    ): Promise<{
      count: number;
      engine: string;
      lines: string[];
      path: string;
      session: string;
    } | null> => ipcRenderer.invoke(ipc.agent.log, connectionId, engine, session, cwd),

    /** List resumable AI-CLI conversations. */
    resumable: (connectionId: string): Promise<
      {
        engine: string;
        project: string;
        when: string;
        label: string;
        running: boolean;
      }[]
    > => ipcRenderer.invoke(ipc.agent.resumable, connectionId),

    /** Agent config-dir profiles. */
    profiles: (connectionId: string): Promise<unknown[]> =>
      ipcRenderer.invoke(ipc.agent.profiles, connectionId),

    /** Env keys for a folder. */
    envList: (connectionId: string, dir: string): Promise<unknown[]> =>
      ipcRenderer.invoke(ipc.agent.envList, connectionId, dir),

    /** Env values for a folder. */
    envGet: (connectionId: string, dir: string): Promise<Record<string, string>> =>
      ipcRenderer.invoke(ipc.agent.envGet, connectionId, dir),
  },
} as const;

export type Api = typeof api;

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api);
  } catch (error) {
    console.error('Failed to expose api in the context bridge:', error);
  }
} else {
  // Fallback when context isolation is disabled (shouldn't happen in prod,
  // but keeps dev tooling from crashing if a flag is flipped).
  (window as unknown as { api: Api }).api = api;
}
