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

  // There is deliberately NO `create(name, cwd)` here any more.
  //
  // It existed only for SessionTree's bare "new session name" field, which had
  // the model backwards: a session belongs to a project FOLDER and its name is
  // derived from that folder, so a typed name produced sessions the Android
  // client and `tmuxctl` could not group with anything. The field and this
  // action went together; creation now runs through
  // `useProjectsStore().start()` -> `projects:startSession`, which derives the
  // name host-side. `helper.sessionsCreate` survives on the preload as the
  // escape hatch for a caller that already knows the exact tmux name it wants.

  function clear(): void {
    sessions.value = [];
    error.value = null;
  }

  return { sessions, loading, error, refresh, clear };
});
