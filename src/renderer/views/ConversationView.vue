<script setup lang="ts">
// ConversationView: the conversation of the session the user is looking at,
// rendered as a message list (user/assistant prose + collapsible tool calls).
//
// There is no conversation picker, by design. The tab is mounted inside a
// session workspace and the session IS the selection — asking the user to
// choose again was never a feature, it was a workaround for the fact that
// `pocketshell agent-log --session S` wants the ENGINE'S transcript id (a
// claude uuid, a codex rollout stem) and not the tmux session name the route
// carries. Passing the tmux name straight through matched nothing, exit 66
// came back as "no log", and the panel went blank — so the engine dropdown
// and the free-text id field were the only way anyone ever got a transcript
// on screen. The mapping is now resolved main-side from the session's cwd and
// its recorded `@ps_agent_kind` (src/main/agents/transcripts.ts).
//
// Two things this view therefore owes the user:
//   - it RELOADS when the selected session changes. The tab is re-created on
//     a tab switch, but switching sessions in the left panel while the
//     Conversation tab is already open only changes the route param, leaving
//     this component mounted — a `watch` on the prop, not `onMounted`, is
//     what covers both.
//   - it never renders an empty pane in silence. Every failure to resolve or
//     load has a sentence attached to it.
import { computed, ref, watch } from 'vue';
import { useConnectionStore } from '../stores/connection';
import AppIcon from '../components/AppIcon.vue';
import { useAgentsStore } from '../stores/agents';
import { useSessionsStore } from '../stores/sessions';
import type { ConversationBlock } from '../../main/agents/conversation';

const props = defineProps<{
  /** The selected session's tmux name — the only input this view takes. */
  sessionId?: string;
}>();

const connection = useConnectionStore();
const sessions = useSessionsStore();
const agents = useAgentsStore();
const connId = computed(() => connection.connectionId);
const sessionName = computed(() => props.sessionId?.trim() ?? '');

/**
 * The session row, which is where the cwd and the recorded agent kind live.
 * Those two are the whole input to transcript resolution, so this view cannot
 * do anything useful until the sessions store has them.
 */
const summary = computed(
  () => sessions.sessions.find((s) => s.name === sessionName.value) ?? null,
);

/**
 * Why the badge is there when it is: codex and opencode keep the project
 * directory inside the transcript rather than in its path, so the match rests
 * on "this session's engine, most recently written" and the user is told that
 * instead of being shown a confident-looking header.
 */
const unverifiedHint = computed(
  () =>
    `${agents.source?.engine ?? 'These'} transcripts do not record the project directory ` +
    'in their path, so this is the newest one for this engine on the host.',
);

const expanded = ref<Set<string>>(new Set());
function toggle(key: string): void {
  if (expanded.value.has(key)) expanded.value.delete(key);
  else expanded.value.add(key);
}

async function load(): Promise<void> {
  const id = connId.value;
  if (!id) {
    agents.fail('Not connected to a host.');
    return;
  }
  if (!sessionName.value) {
    agents.fail('No session selected.');
    return;
  }
  // A deep link or a window reload can reach this tab before the session list
  // has been fetched. Refreshing is not optional politeness: without the row
  // there is no cwd and no agent kind, and resolution would be a guess.
  if (!summary.value) await sessions.refresh(id);
  const row = summary.value;
  if (!row) {
    agents.fail(
      `Session "${sessionName.value}" is not in this host's session list — ` +
        'it may have been closed. Reconnect or pick another session.',
    );
    return;
  }
  await agents.loadForSession(id, row);
}

// `immediate` covers the mount; the watch covers the case the tab stays
// mounted while the route's session param changes underneath it. The
// connection id is in the key too, so reconnecting reloads rather than
// leaving the previous host's transcript on screen.
watch(
  () => [connId.value, sessionName.value] as const,
  () => {
    void load();
  },
  { immediate: true },
);

function blockKey(i: number, j: number): string {
  return `${i}-${j}`;
}
function isText(b: ConversationBlock): boolean {
  return b.type === 'text';
}
</script>

<template>
  <div class="conversation">
    <!-- Not a picker: a receipt. It says which transcript is on screen, which
         is the only way the user can tell a stale conversation from a wrong
         one — and it is the honest place to admit an unverified match. -->
    <div class="bar">
      <template v-if="agents.source">
        <span class="engine">{{ agents.source.engine }}</span>
        <span class="transcript" :title="agents.source.path">{{ agents.source.transcriptId }}</span>
        <span v-if="!agents.source.cwdVerified" class="unverified" :title="unverifiedHint">
          newest for this engine
        </span>
      </template>
      <span v-else class="muted transcript">{{ sessionName || 'no session' }}</span>
      <button
        class="icon-btn refresh"
        title="Reload this session's conversation"
        :disabled="agents.loading"
        @click="load"
      >
        <AppIcon name="refresh" :class="{ spin: agents.loading }" />
      </button>
    </div>

    <div class="messages">
      <div
        v-for="(msg, i) in agents.messages"
        :key="i"
        :class="['message', msg.role]"
      >
        <span class="role">{{ msg.role }}</span>
        <template v-for="(block, j) in msg.blocks" :key="j">
          <div v-if="isText(block)" class="text">{{ block.text }}</div>
          <div v-else :class="['block', block.type]">
            <button class="block-toggle" @click="toggle(blockKey(i, j))">
              <AppIcon name="tool" :size="12" />
              {{ block.type === 'tool_call' ? block.text : 'result' }}
              <AppIcon
                name="chevron-right"
                :size="12"
                class="disclosure"
                :class="{ open: expanded.has(blockKey(i, j)) }"
              />
            </button>
            <pre v-if="expanded.has(blockKey(i, j))">{{ block.detail }}</pre>
          </div>
        </template>
      </div>
      <p v-if="agents.loading && !agents.messages.length" class="muted empty">
        loading this session's conversation…
      </p>
      <!-- The error is the empty state. There is no "nothing here" copy to
           fall through to, because "nothing here" with no reason is exactly
           the failure this view used to have. -->
      <p v-if="agents.error" class="error">{{ agents.error }}</p>
    </div>
  </div>
</template>

<style scoped>
/* `flex: 1` because the parent `.tab-body` is a flex row: without it this
   view is shrink-to-fit and its toolbar surface stops mid-pane. */
.conversation {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  height: 100%;
}
.bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--control-h);
  flex: 0 0 auto;
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.engine {
  font-family: var(--font-mono);
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  color: var(--agent);
}
/* The id, with the full host path on the tooltip: a uuid is long enough to
   need truncating and the path is longer still, but the path is what makes
   the claim checkable, so it stays reachable rather than displayed. */
.transcript {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-200);
  color: var(--fg-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* One badge metric across the app (docs/POLISH.md §7). */
.unverified {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg-muted);
  padding: 0 var(--sp-1);
  line-height: var(--lh-100);
  min-height: var(--control-h-sm);
  font-size: var(--fs-100);
}
.refresh {
  flex: 0 0 auto;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-4);
}
.message {
  margin-bottom: var(--sp-4);
  max-width: 90%;
}
.message.user {
  margin-left: auto;
}
.message.assistant {
  margin-right: auto;
}
.role {
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-muted);
  display: block;
  margin-bottom: var(--sp-1);
}
/* The two speakers are told apart by a coloured rail, not by a green-vs-blue
   fill — the old rgba(166,227,161,.08) read as a success state, not a voice. */
.text {
  border-radius: var(--r-lg);
  padding: var(--sp-2) var(--sp-3);
  white-space: pre-wrap;
  /* The only prose in the app; --lh-300 (1.3846) is too tight for paragraphs. */
  font-size: var(--fs-300);
  line-height: 1.5;
}
.message.user .text {
  background: var(--accent-soft);
  border-left: 2px solid var(--accent);
}
.message.assistant .text {
  background: var(--surface);
  border-left: 2px solid var(--agent);
}
.block {
  margin-top: var(--sp-1);
}
.block-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  padding: 0 var(--sp-1);
  line-height: var(--lh-100);
  min-height: var(--control-h-sm);
  font-size: var(--fs-100);
  cursor: pointer;
  font-family: var(--font-mono);
}
.block-toggle:hover {
  color: var(--fg);
}
/* Same disclosure pattern as SessionTree: one chevron, 90 degrees when open,
   rotated as an SVG box so it pivots on its own centre. */
.disclosure {
  color: var(--fg-muted);
  transition: transform var(--dur-fast) var(--ease);
}
.disclosure.open {
  transform: rotate(90deg);
}
/* Deliberately the terminal's background, so code blocks and the terminal
   agree about what "a shell surface" looks like. */
.block pre {
  margin: var(--sp-1) 0 0;
  padding: var(--sp-3);
  background: var(--term-bg);
  border-radius: var(--r-md);
  font-family: var(--font-mono);
  font-size: var(--fs-200);
  overflow-x: auto;
  color: var(--term-fg);
}
.empty {
  text-align: center;
  padding: var(--sp-6);
}
.error {
  padding: 0 var(--sp-4);
}
</style>
