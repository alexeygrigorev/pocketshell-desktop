import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import { api } from '../ipc';
import type {
  BootstrapResult,
  ConnectionId,
  ConnectionState,
  HostEntry,
} from '../../shared/types';

/**
 * Connection store: owns the active connection to a host and its bootstrap
 * result. View state only — no keys or ssh2 objects ever live here.
 */
export const useConnectionStore = defineStore('connection', () => {
  const hosts = ref<HostEntry[]>([]);
  const connectionId = ref<ConnectionId | null>(null);
  const state = ref<ConnectionState>('idle');
  const error = ref<string | null>(null);
  const bootstrap = ref<BootstrapResult | null>(null);
  /** The host we are currently connected to (for the workspace header). */
  const activeHost = shallowRef<HostEntry | null>(null);

  /**
   * The key last used to dial {@link activeHost}, kept so a dropped link can be
   * re-dialled without asking the user to re-pick it.
   */
  const lastKeyPath = ref<string | undefined>(undefined);

  /**
   * Learn when the transport drops.
   *
   * The main process has always emitted this (ipc.ts, `ssh:event:state`) and
   * the preload has always bridged it, but nothing in the renderer subscribed —
   * so a link that died left the store reporting `connected` with a
   * connectionId whose record main had already torn down. Every subsequent call
   * on it failed, and the two surfaces that matter both failed silently: the
   * terminal pane stayed blank and the Files tab rendered an empty directory.
   * The only cure was a manual disconnect/reconnect, which is exactly the
   * symptom that says the UI never learned.
   *
   * `connectionId` is deliberately NOT cleared here. It gates `v-if` on the
   * terminal and Files panes, so nulling it would unmount them and throw away
   * the user's scrollback at the precise moment they want to read it. The
   * state flag is enough for the UI to say the link is gone and offer
   * {@link reconnect}; calls made against the dead id now report their own
   * failure rather than vanishing.
   *
   * Subscribed for the store's lifetime — a Pinia setup store is created once,
   * and this must outlive any individual view.
   */
  api.ssh.onState((payload) => {
    if (payload.connectionId !== connectionId.value) return;
    state.value = payload.state;
    if (payload.state === 'lost') error.value = 'Connection lost';
  });

  async function loadHosts(): Promise<void> {
    hosts.value = await api.ssh.listConfigHosts();
  }

  /**
   * Re-dial the host we were last connected to, after a drop.
   *
   * Returns false when there is nothing to re-dial — this is for recovering a
   * link that died, not for opening the first one.
   */
  async function reconnect(): Promise<boolean> {
    const host = activeHost.value;
    if (!host) return false;
    if (connectionId.value) {
      // Best-effort: main has usually torn the record down already, and a
      // close on an unknown id must not stop the re-dial.
      await api.ssh.close(connectionId.value).catch(() => undefined);
      connectionId.value = null;
    }
    return connect(host, lastKeyPath.value);
  }

  async function connect(host: HostEntry, privateKeyPath?: string): Promise<boolean> {
    state.value = 'connecting';
    error.value = null;
    activeHost.value = host;
    lastKeyPath.value = privateKeyPath;
    const result = await api.ssh.connect({
      host: host.hostname,
      port: host.port,
      user: host.user || '',
      privateKeyPath: privateKeyPath ?? host.identityFile ?? undefined,
      tofuDecision: 'accept-always',
    });
    if (result.ok && result.connectionId) {
      connectionId.value = result.connectionId;
      state.value = 'connected';
      // Fire bootstrap in the background; the UI surfaces it when it lands.
      void api.helper.bootstrap(result.connectionId).then((b) => {
        bootstrap.value = b;
      });
      return true;
    }
    state.value = 'idle';
    error.value = result.error ?? 'Connection failed';
    return false;
  }

  async function disconnect(): Promise<void> {
    if (connectionId.value) {
      await api.ssh.close(connectionId.value);
    }
    connectionId.value = null;
    state.value = 'idle';
    bootstrap.value = null;
    activeHost.value = null;
    lastKeyPath.value = undefined;
  }

  return {
    hosts,
    connectionId,
    state,
    error,
    bootstrap,
    activeHost,
    loadHosts,
    connect,
    reconnect,
    disconnect,
  };
});
