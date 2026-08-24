<script setup lang="ts">
// ConversationView: renders an agent's conversation log as a clean message
// list (user/assistant prose + collapsible tool calls). Lets the user pick
// the engine + session id, then loads via `pocketshell agent-log`.
import { ref, computed, onMounted } from 'vue';
import { useConnectionStore } from '../stores/connection';
import AppIcon from '../components/AppIcon.vue';
import { useAgentsStore } from '../stores/agents';
import type { ConversationBlock } from '../../main/agents/conversation';

const props = defineProps<{
  /** Session whose log to preload — set when rendered inside a session workspace. */
  sessionId?: string;
}>();

const connection = useConnectionStore();
const agents = useAgentsStore();
const connId = computed(() => connection.connectionId);

const engine = ref<'claude' | 'codex' | 'opencode'>('claude');
const sessionInput = ref(props.sessionId ?? '');

const expanded = ref<Set<string>>(new Set());
function toggle(key: string): void {
  if (expanded.value.has(key)) expanded.value.delete(key);
  else expanded.value.add(key);
}

async function onLoad(): Promise<void> {
  if (!connId.value || !sessionInput.value.trim()) return;
  await agents.loadLog(connId.value, engine.value, sessionInput.value.trim());
}

async function onLoadResumable(): Promise<void> {
  if (!connId.value) return;
  await agents.loadResumable(connId.value);
}

onMounted(() => {
  void onLoadResumable();
  // Scoped to a session: load its log straight away instead of making the
  // user retype the id the route already knows.
  if (sessionInput.value) void onLoad();
});

function blockKey(i: number, j: number): string {
  return `${i}-${j}`;
}
function isText(b: ConversationBlock): boolean {
  return b.type === 'text';
}
</script>

<template>
  <div class="conversation">
    <div class="bar">
      <select v-model="engine">
        <option value="claude">claude</option>
        <option value="codex">codex</option>
        <option value="opencode">opencode</option>
      </select>
      <input
        v-model="sessionInput"
        placeholder="session id"
        class="session-input"
        @keyup.enter="onLoad"
      />
      <button class="load-btn" :disabled="agents.loading" @click="onLoad">
        {{ agents.loading ? '…' : 'Load' }}
      </button>
    </div>

    <div v-if="agents.resumable.length" class="resumable">
      <span class="muted label">resumable:</span>
      <button
        v-for="r in agents.resumable.slice(0, 8)"
        :key="`${r.engine}-${r.project}-${r.when}`"
        class="resume-chip"
        @click="engine = r.engine as 'claude' | 'codex' | 'opencode'; sessionInput = ''; onLoad()"
        :title="r.label"
      >
        {{ r.engine }} · {{ r.project }} · {{ r.when }}
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
      <p v-if="!agents.messages.length && !agents.loading" class="muted empty">
        load a session to see the conversation
      </p>
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
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.bar select,
.session-input,
.load-btn {
  height: var(--control-h);
  background: var(--surface-2);
  /* WCAG 1.4.11: controls need a >=3:1 boundary; --border is 1.49:1. */
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  padding: 0 var(--sp-2);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
}
.session-input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
}
.session-input::placeholder {
  color: var(--fg-muted);
}
.load-btn {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
  padding: 0 var(--sp-3);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.load-btn:hover:not(:disabled) {
  background: var(--accent-dim);
  color: var(--fg);
}
.load-btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.resumable {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.label {
  font-size: var(--fs-100);
}
/* One badge metric across the app (docs/POLISH.md §7). */
.resume-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--accent);
  padding: 0 var(--sp-1);
  line-height: var(--lh-100);
  min-height: var(--control-h-sm);
  font-size: var(--fs-100);
  cursor: pointer;
  font-family: var(--font-mono);
  transition: background var(--dur-fast) var(--ease);
}
.resume-chip:hover {
  background: var(--state-active);
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
