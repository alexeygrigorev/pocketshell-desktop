import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId } from '../../shared/types';
import type { UsageRow } from '../../main/helper/parsers';

/**
 * Agents store: the provider-usage dashboard rows, and nothing else.
 *
 * It used to also hold the CONVERSATION of the selected session — messages,
 * the transcript the messages came from, and a stale-reply guard keyed on the
 * session name. That whole half is gone, with the feature (docs/WORKSPACE.md
 * §9): the user asked for conversations to be dropped completely, so the tab,
 * the transcript resolver, the `agent-log` client and the IPC behind them were
 * removed rather than left as an unused path (docs/ANALYSIS.md D22).
 *
 * `loading` survived that cut and is worth a note, because it is the one thing
 * the removal could have broken silently. It was written ONLY by the
 * conversation loader, but it is READ by the usage refresh button in
 * UsageView.vue and HostWorkspaceView.vue — so deleting the writer would have
 * left a spinner that never spins and a button that is never disabled, with
 * nothing to say why. `loadUsage` owns it now.
 */
export const useAgentsStore = defineStore('agents', () => {
  const usage = ref<UsageRow[]>([]);
  /** True while `loadUsage` is in flight — drives the refresh spinner. */
  const loading = ref(false);

  async function loadUsage(connectionId: ConnectionId): Promise<void> {
    loading.value = true;
    try {
      usage.value = await api.helper.usage(connectionId);
    } finally {
      loading.value = false;
    }
  }

  return { usage, loading, loadUsage };
});
