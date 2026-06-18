import { contextBridge, ipcRenderer } from 'electron';
import { ipc } from '../shared/channels.js';
import type {
  ConnectResult,
  ExecResult,
  HostEntry,
} from '../shared/types.js';

/**
 * The typed API surface exposed to the renderer as `window.api`.
 *
 * The renderer is sandboxed (contextIsolation: true, nodeIntegration: false),
 * so this is the ONLY way it can reach the main process. No Node primitives,
 * no ssh2, no filesystem, no keys ever cross this bridge — only the typed
 * values in src/shared/types.ts.
 */

const api = {
  ssh: {
    /** Read ~/.ssh/config into HostEntry rows. Empty if no config. */
    listConfigHosts: (): Promise<HostEntry[]> =>
      ipcRenderer.invoke(ipc.ssh.listConfigHosts),

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
