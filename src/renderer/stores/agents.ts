import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId, SessionSummary } from '../../shared/types';
import {
  renderConversation,
  type ConversationMessage,
} from '../../main/agents/conversation';
import {
  transcriptEngineFromAgentKind,
  type TranscriptEngine,
} from '../../main/agents/transcripts';
import type { UsageRow } from '../../main/helper/parsers';

/** Which transcript the messages on screen actually came from. */
export interface ConversationSource {
  engine: TranscriptEngine;
  transcriptId: string;
  /** Absolute path on the host — the one thing that makes this checkable. */
  path: string;
  /** False when the match rests on engine + recency rather than on the cwd. */
  cwdVerified: boolean;
}

/**
 * Agents store: the conversation of the session the user is looking at, plus
 * the usage dashboard rows.
 *
 * There is deliberately NO engine/session selection state here any more. The
 * conversation is a property of the SELECTED SESSION, not something the user
 * picks: `loadForSession` takes the session row and the main process resolves
 * the transcript id from it (see main/agents/transcripts.ts). The old
 * `engine` / `session` refs and the `resumable` chip list existed only to
 * feed the picker in ConversationView and went with it.
 */
export const useAgentsStore = defineStore('agents', () => {
  const messages = ref<ConversationMessage[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** Name of the session `messages` belongs to, so a stale reply can be dropped. */
  const session = ref('');
  const source = ref<ConversationSource | null>(null);

  const usage = ref<UsageRow[]>([]);

  /**
   * Load the conversation belonging to [summary].
   *
   * Every exit from this function either fills `messages` or sets `error` —
   * never both empty. The panel had a silent-failure mode before (a helper
   * that answered "not found" left the pane blank with no explanation, which
   * read as "this session has no conversation" and sent the user hunting for
   * a picker), and that is the one outcome this must not have.
   */
  async function loadForSession(
    connectionId: ConnectionId,
    summary: SessionSummary,
  ): Promise<void> {
    loading.value = true;
    error.value = null;
    session.value = summary.name;
    try {
      const res = await api.agent.sessionLog(connectionId, {
        session: summary.name,
        engine: transcriptEngineFromAgentKind(summary.agentKind),
        cwd: summary.path,
      });
      // A session switch that landed while this was in flight owns the panel
      // now; dropping the reply is the only way its messages do not overwrite
      // the newer session's.
      if (session.value !== summary.name) return;
      if (!res.ok) {
        messages.value = [];
        source.value = null;
        error.value = res.error;
        return;
      }
      source.value = {
        engine: res.engine,
        transcriptId: res.transcriptId,
        path: res.path,
        cwdVerified: res.cwdVerified,
      };
      messages.value = renderConversation(res.engine, res.lines);
      if (!messages.value.length) {
        error.value =
          `Read ${res.lines.length} line(s) from ${res.path} but none of them ` +
          `parsed as ${res.engine} conversation messages.`;
      }
    } catch (e) {
      if (session.value !== summary.name) return;
      messages.value = [];
      source.value = null;
      error.value = (e as Error).message;
    } finally {
      // Only the newest request may clear the spinner — a stale one finishing
      // second would otherwise say "done" over a load still in flight.
      if (session.value === summary.name) loading.value = false;
    }
  }

  /** Report a failure the renderer itself detected (e.g. no such session). */
  function fail(message: string): void {
    messages.value = [];
    source.value = null;
    loading.value = false;
    error.value = message;
  }

  async function loadUsage(connectionId: ConnectionId): Promise<void> {
    usage.value = await api.helper.usage(connectionId);
  }

  function clear(): void {
    messages.value = [];
    usage.value = [];
    source.value = null;
    session.value = '';
    error.value = null;
  }

  return {
    messages,
    loading,
    error,
    session,
    source,
    usage,
    loadForSession,
    fail,
    loadUsage,
    clear,
  };
});
