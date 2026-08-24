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
//   - No window child rows — `SessionSummary` carries no window list.
//   - Last-activity is shown on the row (the phone shows no timestamp); the
//     desktop has the room and already had this column.
import { computed, onMounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { api } from '../ipc';
import { useConnectionStore } from '../stores/connection';
import { useSessionsStore } from '../stores/sessions';
import { groupSessionsByFolder } from '../sessionGrouping';
import type { SessionAgentKind, SessionSummary } from '../../shared/types';

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
  // Every session needs a start folder. This legacy name-entry path has no
  // folder to offer, so it starts in the remote $HOME; the folder-first flow
  // (projects.startSession) is what picks a real project directory.
  const home = await api.projects.home(connection.connectionId);
  const ok = home.ok && home.home
    ? await sessions.create(connection.connectionId, name, home.home)
    : false;
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

/**
 * Row badge for the host-recorded `@ps_agent_kind` (types.ts:103). Null,
 * undefined and `unknown` are all the phone's "Unknown" and get NO badge — a
 * foreign session we did not launch should not be labelled as if we had.
 * `shell` gets none either: a shell is the unremarkable case.
 */
function agentBadge(kind: SessionAgentKind | null | undefined): string | null {
  switch (kind) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
    case 'grok':
      return 'grok';
    case 'probing':
      return 'probing…';
    case 'exited':
      return 'exited';
    case 'shell':
    case 'unknown':
    case null:
    case undefined:
      return null;
    default:
      return null;
  }
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
        <AppIcon name="refresh" :size="14" :class="{ spin: sessions.loading }" />
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
          <AppIcon
            name="chevron-right"
            :size="14"
            class="disclosure"
            :class="{ open: isExpanded(folder.path) }"
          />
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
            <span
              v-if="agentBadge(s.agentKind)"
              class="agent-badge"
              :class="{ dim: s.agentKind === 'probing' || s.agentKind === 'exited' }"
              :title="`agent: ${s.agentKind}`"
            >
              {{ agentBadge(s.agentKind) }}
            </span>
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
      <button
        class="icon-btn"
        :disabled="creating || !newSessionName.trim()"
        title="Create session"
        @click="onCreate"
      >
        <AppIcon name="plus" />
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
  background: var(--surface);
  border-right: 1px solid var(--border);
}
.tree-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--topbar-h);
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.title {
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-muted);
}
.folder-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2) 0;
}
.folder {
  margin-bottom: var(--sp-1);
}
.folder-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  height: var(--row-h);
  background: transparent;
  border: none;
  color: var(--fg);
  text-align: left;
  padding: 0 var(--sp-3) 0 var(--sp-2);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-400);
  line-height: var(--lh-400);
  font-weight: var(--fw-semibold);
}
.folder-header:hover {
  background: var(--state-hover);
}
/* One disclosure pattern, shared with ConversationView: the base mark is
   always `chevron-right` and open is a 90 degree rotation, so the two states
   are the same geometry. Rotating the <svg> box pivots around its own centre
   -- no transform-origin juggling and no baseline offset, which is what made
   the old text caret land crooked. The 14px icon box IS the slot; the former
   `width: 12px` / `font-size` declarations are gone. */
.disclosure {
  color: var(--fg-muted);
  transition: transform var(--dur-fast) var(--ease);
}
.disclosure.open {
  transform: rotate(90deg);
}
.folder-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-count {
  font-weight: var(--fw-regular);
  font-size: var(--fs-100);
  white-space: nowrap;
}
.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.session-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: var(--row-h);
  /* 2px of the left inset is the selection rail's slot, so a row does not
     shift horizontally when it becomes current.
     28px, not --sp-4: the folder header is --sp-2 (8) + the 14px disclosure
     box + an --sp-2 gap = 30px to its dot, so 2px rail + 28 puts a child dot
     exactly under its parent's and the session name under the folder label.
     Children used to outdent their own parent. */
  padding: var(--row-pad-y) var(--row-pad-x) var(--row-pad-y) 28px;
  border-left: 2px solid transparent;
  cursor: pointer;
  font-size: var(--fs-300);
  line-height: var(--lh-300);
}
.session-row:hover {
  background: var(--state-hover);
}
/* Selection is accent-tinted and railed; hover is a neutral lift. The two
   used to be the same cyan at two alphas, which read as one state. */
.session-row.current {
  background: var(--state-selected);
  border-left-color: var(--accent);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-muted);
  flex-shrink: 0;
}
.dot.active {
  background: var(--success);
}
.session-name {
  font-family: var(--font-mono);
  color: var(--fg);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Badge metric, shared by every --r-sm chip in the app (docs/POLISH.md §7):
   inline-flex, 0 var(--sp-1) padding, --lh-100. */
.agent-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex-shrink: 0;
  line-height: var(--lh-100);
  font-size: var(--fs-100);
  font-weight: var(--fw-medium);
  color: var(--agent);
  background: var(--agent-soft);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: 0 var(--sp-1);
  white-space: nowrap;
}
/* Transient detector states read as "not settled yet", not as a live agent. */
.agent-badge.dim {
  color: var(--fg-secondary);
  background: transparent;
  border-color: var(--border);
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  line-height: var(--lh-100);
  font-size: var(--fs-100);
  color: var(--fg-secondary);
  border: 1px solid var(--border);
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
}
.session-time {
  font-size: var(--fs-100);
  color: var(--fg-secondary);
  text-align: right;
  white-space: nowrap;
}
.new-session {
  display: flex;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border-top: 1px solid var(--border);
}
.new-session input {
  flex: 1;
  min-width: 0;
  height: var(--control-h);
  background: var(--surface-2);
  /* WCAG 1.4.11: --border (1.49:1) cannot be the sole boundary of a control. */
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  padding: 0 var(--sp-2);
  color: var(--fg);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
}
.new-session input::placeholder {
  color: var(--fg-muted);
}
.error {
  padding: 0 var(--sp-3) var(--sp-2);
}
</style>
