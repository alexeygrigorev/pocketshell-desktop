<script setup lang="ts">
// Session tree: lists live tmux sessions for the active connection, lets the
// user pick one to attach (emits `attach`), create a new one, or refresh.
import { onMounted, ref } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { useSessionsStore } from '../stores/sessions';
import type { SessionSummary } from '../../shared/types';

const emit = defineEmits<{ attach: [session: SessionSummary] }>();

const connection = useConnectionStore();
const sessions = useSessionsStore();
const newSessionName = ref('');
const creating = ref(false);

onMounted(async () => {
  if (connection.connectionId) {
    await sessions.refresh(connection.connectionId);
  }
});

async function onRefresh(): Promise<void> {
  if (connection.connectionId) await sessions.refresh(connection.connectionId);
}

async function onCreate(): Promise<void> {
  const name = newSessionName.value.trim();
  if (!name || !connection.connectionId) return;
  creating.value = true;
  const ok = await sessions.create(connection.connectionId, name);
  creating.value = false;
  if (ok) newSessionName.value = '';
}

function fmtTime(epoch: number): string {
  if (!epoch) return '';
  const d = new Date(epoch * 1000);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div class="tree">
    <div class="tree-header">
      <span class="title">sessions</span>
      <button class="icon-btn" :disabled="sessions.loading" @click="onRefresh" title="Refresh">
        {{ sessions.loading ? '…' : '⟳' }}
      </button>
    </div>

    <ul class="session-list">
      <li
        v-for="s in sessions.sessions"
        :key="s.name"
        class="session-row"
        @click="emit('attach', s)"
      >
        <span class="dot" :class="{ attached: s.attached }" />
        <span class="session-name">{{ s.name }}</span>
        <span v-if="s.attached" class="tag">attached</span>
        <span class="session-time">{{ fmtTime(s.activity || s.created) }}</span>
      </li>
      <li v-if="!sessions.sessions.length && !sessions.loading" class="empty muted">
        no sessions
      </li>
    </ul>

    <div class="new-session">
      <input
        v-model="newSessionName"
        placeholder="new session name"
        @keyup.enter="onCreate"
        :disabled="creating"
      />
      <button class="icon-btn" :disabled="creating || !newSessionName.trim()" @click="onCreate">
        +
      </button>
    </div>
    <p v-if="sessions.error" class="error">{{ sessions.error }}</p>
  </div>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 240px;
  border-right: 1px solid var(--border);
}
.tree-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
}
.title {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.session-list {
  list-style: none;
  margin: 0;
  padding: 0.5rem 0;
  flex: 1;
  overflow-y: auto;
}
.session-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 1rem;
  cursor: pointer;
  font-size: 0.9rem;
}
.session-row:hover {
  background: rgba(137, 180, 250, 0.08);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
}
.dot.attached {
  background: #a6e3a1;
}
.session-name {
  font-family: ui-monospace, monospace;
  flex: 1;
}
.tag {
  font-size: 0.7rem;
  color: var(--muted);
  border: 1px solid var(--border);
  padding: 0 0.3rem;
  border-radius: 3px;
}
.session-time {
  font-size: 0.75rem;
  color: var(--muted);
}
.empty {
  padding: 1rem;
  font-style: italic;
}
.new-session {
  display: flex;
  gap: 0.4rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border);
}
.new-session input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.35rem 0.5rem;
  color: var(--fg);
  font-size: 0.85rem;
}
.icon-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  padding: 0.2rem 0.6rem;
  cursor: pointer;
  font-size: 0.95rem;
}
.icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.muted {
  color: var(--muted);
}
.error {
  color: var(--error);
  padding: 0 1rem;
  font-size: 0.8rem;
}
</style>
