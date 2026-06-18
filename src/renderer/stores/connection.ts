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

  async function loadHosts(): Promise<void> {
    hosts.value = await api.ssh.listConfigHosts();
  }

  async function connect(host: HostEntry, privateKeyPath?: string): Promise<boolean> {
    state.value = 'connecting';
    error.value = null;
    activeHost.value = host;
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
    activeHost.value = null;
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
    disconnect,
  };
});
