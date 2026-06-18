import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId } from '../../shared/types';
import {
  renderConversation,
  type ConversationMessage,
} from '../../main/agents/conversation';
import type { ResumableSession } from '../../main/helper/parsers';
import type { UsageRow } from '../../main/helper/parsers';

/**
 * Agents store: holds the rendered conversation for the selected agent log,
 * the resumable-conversation list, and the usage dashboard rows.
 */
export const useAgentsStore = defineStore('agents', () => {
  const engine = ref<'claude' | 'codex' | 'opencode'>('claude');
  const session = ref('');
  const messages = ref<ConversationMessage[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const resumable = ref<ResumableSession[]>([]);
  const usage = ref<UsageRow[]>([]);

  async function loadLog(connectionId: ConnectionId, eng: typeof engine.value, sess: string): Promise<void> {
    loading.value = true;
    error.value = null;
    engine.value = eng;
    session.value = sess;
    try {
      const env = await api.agent.log(connectionId, eng, sess);
      if (!env || !env.lines.length) {
        messages.value = [];
        return;
      }
      messages.value = renderConversation(eng, env.lines);
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function loadResumable(connectionId: ConnectionId): Promise<void> {
    resumable.value = await api.agent.resumable(connectionId);
  }

  async function loadUsage(connectionId: ConnectionId): Promise<void> {
    usage.value = await api.helper.usage(connectionId);
  }

  function clear(): void {
    messages.value = [];
    resumable.value = [];
    usage.value = [];
    error.value = null;
  }

  return { engine, session, messages, loading, error, resumable, usage, loadLog, loadResumable, loadUsage, clear };
});
