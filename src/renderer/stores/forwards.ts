import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId, ForwardSpec } from '../../shared/types';
import type { RemotePort } from '../../main/portfwd/PortScanner';
import type { ForwardState } from '../../main/portfwd/Forwarder';

/**
 * Forwards store: the port-forward table for the active connection. Holds the
 * remote port scan + the live forward states, and exposes the auto-forward
 * toggle + manual add/remove.
 */
export const useForwardsStore = defineStore('forwards', () => {
  const remotePorts = ref<RemotePort[]>([]);
  const states = ref<ForwardState[]>([]);
  const autoOn = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);

  let unsub: (() => void) | null = null;

  function subscribe(connectionId: ConnectionId): void {
    if (unsub) unsub();
    unsub = api.forwards.onStates(({ connectionId: id, states: s }) => {
      if (id === connectionId) states.value = s;
    });
  }

  async function scan(connectionId: ConnectionId): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      remotePorts.value = await api.forwards.scan(connectionId);
      states.value = await api.forwards.list(connectionId);
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function toggleAuto(connectionId: ConnectionId): Promise<void> {
    if (autoOn.value) {
      await api.forwards.stopAuto(connectionId);
      autoOn.value = false;
    } else {
      await api.forwards.startAuto(connectionId);
      autoOn.value = true;
    }
  }

  async function addManual(
    connectionId: ConnectionId,
    spec: ForwardSpec,
  ): Promise<boolean> {
    const ok = await api.forwards.addManual(connectionId, spec);
    if (ok) states.value = await api.forwards.list(connectionId);
    return ok;
  }

  async function remove(connectionId: ConnectionId, key: string): Promise<void> {
    await api.forwards.remove(connectionId, key);
    states.value = await api.forwards.list(connectionId);
  }

  function clear(): void {
    if (unsub) {
      unsub();
      unsub = null;
    }
    remotePorts.value = [];
    states.value = [];
    autoOn.value = false;
    error.value = null;
  }

  return { remotePorts, states, autoOn, loading, error, subscribe, scan, toggleAuto, addManual, remove, clear };
});
