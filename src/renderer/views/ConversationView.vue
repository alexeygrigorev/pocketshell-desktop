<script setup lang="ts">
// ConversationView: renders an agent's conversation log as a clean message
// list (user/assistant prose + collapsible tool calls). Lets the user pick
// the engine + session id, then loads via `pocketshell agent-log`.
import { ref, computed, onMounted } from 'vue';
import { useConnectionStore } from '../stores/connection';
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
              🔧 {{ block.type === 'tool_call' ? block.text : 'result' }}
              <span class="muted">{{ expanded.has(blockKey(i, j)) ? '▼' : '▶' }}</span>
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
.conversation {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.bar {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
  background: #181825;
}
.bar select, .session-input, .load-btn {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--fg);
  padding: 0.25rem 0.5rem;
  font-size: 0.85rem;
}
.session-input {
  flex: 1;
  font-family: ui-monospace, monospace;
}
.load-btn {
  background: var(--accent);
  color: #1e1e2e;
  border: none;
  font-weight: 600;
}
.resumable {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 1rem;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.label {
  font-size: 0.75rem;
}
.resume-chip {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--accent);
  padding: 0.15rem 0.4rem;
  font-size: 0.72rem;
  cursor: pointer;
  font-family: ui-monospace, monospace;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
}
.message {
  margin-bottom: 1rem;
  max-width: 90%;
}
.message.user {
  margin-left: auto;
}
.message.assistant {
  margin-right: auto;
}
.role {
  font-size: 0.7rem;
  text-transform: uppercase;
  color: var(--muted);
  display: block;
  margin-bottom: 0.2rem;
}
.text {
  background: rgba(137, 180, 250, 0.08);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  white-space: pre-wrap;
  font-size: 0.88rem;
  line-height: 1.5;
}
.message.user .text {
  background: rgba(166, 227, 161, 0.08);
}
.block {
  margin-top: 0.3rem;
}
.block-toggle {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--muted);
  padding: 0.15rem 0.4rem;
  font-size: 0.75rem;
  cursor: pointer;
  font-family: ui-monospace, monospace;
}
.block pre {
  margin: 0.3rem 0 0;
  padding: 0.5rem;
  background: #11111b;
  border-radius: 4px;
  font-size: 0.78rem;
  overflow-x: auto;
  color: #bac2de;
}
.muted {
  color: var(--muted);
}
.empty {
  font-style: italic;
  text-align: center;
  padding: 2rem;
}
.error {
  color: var(--error);
}
</style>
