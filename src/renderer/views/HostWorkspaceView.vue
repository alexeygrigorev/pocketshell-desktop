<script setup lang="ts">
// Host workspace: the shell for a connected host.
//
// Layout: a persistent left panel holding the folder-grouped session list,
// and a right pane showing the selected session's workspace. The panel never
// goes away — picking a session only swaps what the right pane renders:
//
//   /host/:name                  -> SessionPlaceholderView (nothing selected)
//   /host/:name/session/:session -> SessionWorkspaceView (Terminal/Conversation/Files)
//
// There is deliberately NO tab bar at this level. Sessions are the default
// view of a host, and tabs belong to the selected session. The two host-scoped
// panels — port forwarding and provider usage — are header buttons that open
// an overlay, because neither is a property of a single session.
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useConnectionStore } from '../stores/connection';
import OverlayPanel from '../components/OverlayPanel.vue';
import SessionTree from '../components/SessionTree.vue';
import PortPanelView from './PortPanelView.vue';
import UsageView from './UsageView.vue';
import type { SessionSummary } from '../../shared/types';

const route = useRoute();
const router = useRouter();
const connection = useConnectionStore();

/** Which host-level panel is open as an overlay, if any. */
const panel = ref<'ports' | 'usage' | null>(null);

/** Session-panel geometry. Collapsed hides it entirely; width is drag-resized. */
const panelCollapsed = ref(false);
const panelWidth = ref(280);
const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = 560;

/** Session named by the route, so the panel can highlight the current row. */
const activeSession = computed(() => (route.params['session'] as string | undefined) ?? null);

function onSelectSession(session: SessionSummary): void {
  if (session.name === activeSession.value) return;
  router.push({
    name: 'session',
    params: { name: route.params['name'] as string, session: session.name },
  });
}

function onDragStart(): void {
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e: MouseEvent): void {
  panelWidth.value = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, e.clientX));
}

function onDragEnd(): void {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
}

onBeforeUnmount(onDragEnd);

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
      <button
        class="icon-btn"
        :title="panelCollapsed ? 'Show session panel' : 'Hide session panel'"
        @click="panelCollapsed = !panelCollapsed"
      >
        ☰
      </button>
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
      <div class="host-actions">
        <button class="icon-btn" @click="panel = 'ports'" title="Port forwarding">Ports</button>
        <button class="icon-btn" @click="panel = 'usage'" title="Provider usage">Usage</button>
        <button class="icon-btn disconnect" @click="onDisconnect">disconnect</button>
      </div>
    </header>

    <div class="body">
      <!-- Persistent session panel: always mounted, never navigated away from. -->
      <aside
        v-show="!panelCollapsed"
        class="session-panel"
        :style="{ width: `${panelWidth}px` }"
      >
        <SessionTree :active-session="activeSession" @select="onSelectSession" />
      </aside>
      <div
        v-show="!panelCollapsed"
        class="splitter"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        @mousedown.prevent="onDragStart"
      />

      <!-- Right pane: the selected session's workspace, or the empty state. -->
      <main class="session-pane">
        <router-view />
      </main>
    </div>

    <!-- Host-level panels: overlays, never peers of the session tabs. -->
    <OverlayPanel v-if="panel === 'ports'" title="Port forwarding" @close="panel = null">
      <PortPanelView v-if="connection.connectionId" />
    </OverlayPanel>
    <OverlayPanel v-if="panel === 'usage'" title="Provider usage" @close="panel = null">
      <UsageView v-if="connection.connectionId" />
    </OverlayPanel>
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
.host-actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-left: auto;
}
.body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.session-panel {
  flex: 0 0 auto;
  min-width: 0;
  overflow: hidden;
}
.splitter {
  flex: 0 0 auto;
  width: 4px;
  cursor: col-resize;
  background: var(--border);
}
.splitter:hover {
  background: var(--accent);
}
.session-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
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
