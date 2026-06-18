<script setup lang="ts">
// Host workspace: the shell for a connected host. Two tabs:
//   - Sessions: session tree + attached terminal (Phase 1 core flow)
//   - Files:    SFTP browser + editor (Phase 2)
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useConnectionStore } from '../stores/connection';
import SessionTree from '../components/SessionTree.vue';
import TerminalView from '../components/TerminalView.vue';
import FilesView from './FilesView.vue';
import type { SessionSummary } from '../../shared/types';

const router = useRouter();
const connection = useConnectionStore();
const selected = ref<SessionSummary | null>(null);
const tab = ref<'sessions' | 'files'>('sessions');

const command = computed(() => {
  if (!selected.value) return undefined;
  return `tmux attach -t '${selected.value.name.replace(/'/g, "'\\''")}'`;
});

function onAttach(session: SessionSummary): void {
  selected.value = session;
}

async function onDisconnect(): Promise<void> {
  await connection.disconnect();
  router.push({ name: 'hosts' });
}

function onBack(): void {
  router.push({ name: 'hosts' });
}
</script>

<template>
  <div class="workspace">
    <header class="topbar">
      <button class="icon-btn" @click="onBack" title="Back to hosts">←</button>
      <span class="host-label">
        {{ connection.activeHost?.name ?? 'host' }}
        <span class="muted">·</span>
        <span class="muted">{{ connection.activeHost?.user }}@{{ connection.activeHost?.hostname }}</span>
      </span>
      <span v-if="connection.bootstrap" class="bootstrap">
        <span :class="['chip', connection.bootstrap.pocketshell.installed ? 'ok' : 'warn']">
          pocketshell {{ connection.bootstrap.pocketshell.installed ? '✓' : '✗' }}
        </span>
        <span :class="['chip', connection.bootstrap.tmux.installed ? 'ok' : 'warn']">
          tmux {{ connection.bootstrap.tmux.installed ? '✓' : '✗' }}
        </span>
      </span>
      <button class="icon-btn disconnect" @click="onDisconnect">disconnect</button>
    </header>

    <nav class="tabs">
      <button :class="['tab', { active: tab === 'sessions' }]" @click="tab = 'sessions'">
        Sessions
      </button>
      <button :class="['tab', { active: tab === 'files' }]" @click="tab = 'files'">
        Files
      </button>
    </nav>

    <div class="body">
      <!-- Sessions tab: tree + terminal -->
      <template v-if="tab === 'sessions'">
        <SessionTree @attach="onAttach" />
        <div class="terminal-area">
          <TerminalView
            v-if="selected && connection.connectionId"
            :connection-id="connection.connectionId"
            :command="command"
            :session-key="selected.name"
          />
          <div v-else class="placeholder">
            <p class="muted">select a session to attach</p>
          </div>
        </div>
      </template>

      <!-- Files tab: SFTP browser + editor -->
      <FilesView v-else-if="connection.connectionId" />
    </div>
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
  background: #181825;
}
.host-label {
  font-weight: 600;
  font-size: 0.95rem;
}
.bootstrap {
  display: flex;
  gap: 0.4rem;
}
.chip {
  font-size: 0.72rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  border: 1px solid var(--border);
}
.chip.ok {
  color: #a6e3a1;
}
.chip.warn {
  color: #f9e2af;
}
.tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0 1rem;
  border-bottom: 1px solid var(--border);
  background: #181825;
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
.body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.terminal-area {
  flex: 1;
  min-width: 0;
  display: flex;
}
.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
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
.disconnect {
  margin-left: auto;
}
</style>
