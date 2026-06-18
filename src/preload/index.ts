import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { ipc } from '../shared/channels.js';
import type {
  BootstrapResult,
  ConnectResult,
  ExecResult,
  HostEntry,
  SessionSummary,
  ShellId,
} from '../shared/types.js';
import type { UsageRow } from '../main/helper/parsers.js';

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
