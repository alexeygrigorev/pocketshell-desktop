<script setup lang="ts">
// SessionTree: the live tmux session list for the active connection, grouped
// by working directory the way the Android app groups its host-detail screen
// (see src/renderer/sessionGrouping.ts for the ported rules).
//
// Structure: folder header (collapsible) -> session rows. Clicking a session
// emits `select`; the caller decides what to open. Folders that hold sessions
// start expanded, matching the phone's default-expansion rule; a manual
// collapse is remembered for as long as the list is mounted.
//
// Deviations from the phone, forced by the desktop session IPC (see report):
//   - No agent-kind badge and no agent-first sort key — `SessionSummary`
//     carries no agent kind.
//   - No window child rows — `SessionSummary` carries no window list.
//   - Last-activity is shown on the row (the phone shows no timestamp); the
//     desktop has the room and already had this column.
import { computed, onMounted, ref } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { useSessionsStore } from '../stores/sessions';
import { groupSessionsByFolder } from '../sessionGrouping';
import type { SessionSummary } from '../../shared/types';

const props = defineProps<{
  /** Name of the session currently open, so its row can be marked. */
  activeSession?: string | null;
}>();

const emit = defineEmits<{ select: [session: SessionSummary] }>();

const connection = useConnectionStore();
const sessions = useSessionsStore();
const newSessionName = ref('');
const creating = ref(false);
/** Folder paths the user explicitly collapsed. Everything else is expanded. */
const collapsed = ref<Set<string>>(new Set());

const folders = computed(() => groupSessionsByFolder(sessions.sessions));

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

function isExpanded(path: string): boolean {
  return !collapsed.value.has(path);
}

function toggleFolder(path: string): void {
  // Reassign so the computed template refs re-render (Set mutation is not deep-reactive here).
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}

/** `1 session` / `3 sessions`, matching the phone's inline folder count. */
function sessionCountLabel(n: number): string {
  return n === 1 ? '1 session' : `${n} sessions`;
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

    <div class="folder-list">
      <section v-for="folder in folders" :key="folder.path" class="folder">
        <button
          class="folder-header"
          :aria-expanded="isExpanded(folder.path)"
          :title="folder.path"
          @click="toggleFolder(folder.path)"
        >
          <span class="disclosure">{{ isExpanded(folder.path) ? '▾' : '▸' }}</span>
          <span class="dot" :class="{ active: folder.active }" />
          <span class="folder-label">{{ folder.label }}</span>
          <span class="folder-count muted">· {{ sessionCountLabel(folder.sessions.length) }}</span>
        </button>

        <ul v-show="isExpanded(folder.path)" class="session-list">
          <li
            v-for="s in folder.sessions"
            :key="s.name"
            class="session-row"
            :class="{ current: s.name === props.activeSession }"
            @click="emit('select', s)"
          >
            <span class="dot" :class="{ active: s.attached }" />
            <span class="session-name">{{ s.name }}</span>
            <span v-if="s.attached" class="tag">attached</span>
            <span class="session-time">{{ fmtTime(s.activity || s.created) }}</span>
          </li>
        </ul>
      </section>

      <p v-if="!folders.length && !sessions.loading" class="empty muted">no sessions</p>
    </div>

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
.folder-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem 0;
}
.folder {
  margin-bottom: 0.25rem;
}
.folder-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--fg);
  text-align: left;
  padding: 0.35rem 1rem;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
}
.folder-header:hover {
  background: rgba(137, 180, 250, 0.08);
}
.disclosure {
  width: 0.8rem;
  color: var(--muted);
}
.folder-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-count {
  font-weight: 400;
  font-size: 0.75rem;
}
.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.session-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 1rem 0.4rem 2rem;
  cursor: pointer;
  font-size: 0.9rem;
}
.session-row:hover {
  background: rgba(137, 180, 250, 0.08);
}
.session-row.current {
  background: rgba(137, 180, 250, 0.14);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
}
.dot.active {
  background: #a6e3a1;
}
.session-name {
  font-family: ui-monospace, monospace;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
