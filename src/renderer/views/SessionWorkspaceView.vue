<script setup lang="ts">
// SessionWorkspaceView: everything scoped to ONE session, rendered in the host
// workspace's right pane. The tabs live here (Terminal / Conversation / Files)
// rather than at the host level, so what you switch between is always
// "this session's ...". The session list stays visible in the left panel.
//
// Two structural notes:
//   - The terminal pane stays mounted (v-show, not v-if) across tab switches;
//     unmounting it would close the SSH shell and drop the tmux attach.
//   - `.session-body` is a column whose tab content flexes, leaving the bottom
//     of this pane free for the prompt composer to dock into later.
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useConnectionStore } from '../stores/connection';
import { useSessionsStore } from '../stores/sessions';
import TerminalView from '../components/TerminalView.vue';
import ConversationView from './ConversationView.vue';
import FilesView from './FilesView.vue';

const route = useRoute();
const router = useRouter();
const connection = useConnectionStore();
const sessions = useSessionsStore();

const tab = ref<'terminal' | 'conversation' | 'files'>('terminal');

/** Session name from the route — the single source of truth for this view. */
const sessionName = computed(() => String(route.params['session'] ?? ''));

/** The matching summary row, when the sessions store has been populated. */
const summary = computed(() => sessions.sessions.find((s) => s.name === sessionName.value) ?? null);

/** Working directory of the session, used to seed the Files tab. */
const sessionPath = computed(() => summary.value?.path ?? undefined);

const command = computed(() => {
  if (!sessionName.value) return undefined;
  return `tmux attach -t '${sessionName.value.replace(/'/g, "'\\''")}'`;
});

onMounted(async () => {
  // Deep-linking straight to a session (or a reload) can leave the store empty;
  // refresh so the header/Files tab get the session's path.
  if (connection.connectionId && !sessions.sessions.length) {
    await sessions.refresh(connection.connectionId);
  }
});

/** Deselect: back to the right pane's empty state, panel untouched. */
function onCloseSession(): void {
  router.push({ name: 'host-sessions', params: { name: route.params['name'] as string } });
}
</script>

<template>
  <div class="session-workspace">
    <header class="session-bar">
      <span class="session-name">{{ sessionName }}</span>
      <span v-if="sessionPath" class="session-path muted">{{ sessionPath }}</span>
      <button class="icon-btn close" @click="onCloseSession" title="Close session view">✕</button>
    </header>

    <nav class="tabs">
      <button :class="['tab', { active: tab === 'terminal' }]" @click="tab = 'terminal'">
        Terminal
      </button>
      <button :class="['tab', { active: tab === 'conversation' }]" @click="tab = 'conversation'">
        Conversation
      </button>
      <button :class="['tab', { active: tab === 'files' }]" @click="tab = 'files'">Files</button>
    </nav>

    <div class="session-body">
      <div class="tab-body">
        <!-- Terminal: kept mounted so switching tabs never drops the attach. -->
        <div v-show="tab === 'terminal'" class="terminal-area">
          <TerminalView
            v-if="connection.connectionId && sessionName"
            :connection-id="connection.connectionId"
            :command="command"
            :session-key="sessionName"
          />
        </div>

        <ConversationView
          v-if="tab === 'conversation' && connection.connectionId"
          :session-id="sessionName"
        />

        <FilesView v-if="tab === 'files' && connection.connectionId" :start-path="sessionPath" />
      </div>
      <!-- The prompt composer docks here, below the tab content. -->
    </div>
  </div>
</template>

<style scoped>
.session-workspace {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.session-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 1rem;
  border-bottom: 1px solid var(--border);
}
.session-name {
  font-family: ui-monospace, monospace;
  font-weight: 600;
}
.session-path {
  font-size: 0.8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.close {
  margin-left: auto;
}
.tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0 1rem;
  border-bottom: 1px solid var(--border);
}
.tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  font-size: 0.85rem;
}
.tab:hover {
  color: var(--fg);
}
.tab.active {
  color: var(--fg);
  border-bottom-color: var(--accent);
}
.session-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.tab-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.terminal-area {
  flex: 1;
  min-width: 0;
  display: flex;
}
.muted {
  color: var(--muted);
}
.icon-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  padding: 0.2rem 0.6rem;
  cursor: pointer;
  font-size: 0.85rem;
}
</style>
