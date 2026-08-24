import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { ipc } from '../shared/channels.js';
import type {
  AttachmentSource,
  BootstrapResult,
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

    /** Create a detached tmux session. */
    sessionsCreate: (connectionId: string, name: string, cwd?: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.helper.sessionsCreate, connectionId, name, cwd),

    /** Provider usage/quota rows. */
    usage: (connectionId: string): Promise<UsageRow[]> =>
      ipcRenderer.invoke(ipc.helper.usage, connectionId),
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
