<script setup lang="ts">
// Host workspace: the shell for a connected host. Left rail = session tree;
// right = the attached terminal for the selected session. Clicking a session
// re-opens the xterm with `tmux attach -t <name>`.
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useConnectionStore } from '../stores/connection';
import SessionTree from '../components/SessionTree.vue';
import TerminalView from '../components/TerminalView.vue';
import type { SessionSummary } from '../../shared/types';

const router = useRouter();
const connection = useConnectionStore();
const selected = ref<SessionSummary | null>(null);

const command = computed(() => {
  if (!selected.value) return undefined;
  // Attach to the named tmux session. `-f` would fail if the session is gone;
  // `attach -t` reattaches or errors visibly in the terminal.
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
    <div class="body">
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
  margin-left: auto;
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
.icon-btn.disconnect {
  margin-left: auto;
}
.icon-btn.disconnect {
  margin-left: 0;
}
.disconnect {
  margin-left: auto;
}
</style>
