import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId, SessionSummary } from '../../shared/types';

/**
 * Sessions store: the live tmux session tree for the active connection.
 * Refreshed from `pocketshell sessions list` (with a raw-tmux fallback baked
 * into the main process).
 */
export const useSessionsStore = defineStore('sessions', () => {
  const sessions = ref<SessionSummary[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function refresh(connectionId: ConnectionId): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      sessions.value = await api.helper.sessionsList(connectionId, 'activity');
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function create(connectionId: ConnectionId, name: string, cwd?: string): Promise<boolean> {
    const ok = await api.helper.sessionsCreate(connectionId, name, cwd);
    if (ok) await refresh(connectionId);
    return ok;
  }

  function clear(): void {
    sessions.value = [];
    error.value = null;
  }

  return { sessions, loading, error, refresh, create, clear };
});
