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
import { useAgentsStore } from '../stores/agents';
import { useConnectionStore } from '../stores/connection';
import AppIcon from '../components/AppIcon.vue';
import OverlayPanel from '../components/OverlayPanel.vue';
import SessionTree from '../components/SessionTree.vue';
import PortPanelView from './PortPanelView.vue';
import UsageView from './UsageView.vue';
import type { SessionSummary } from '../../shared/types';

const route = useRoute();
const router = useRouter();
const connection = useConnectionStore();
const agents = useAgentsStore();

/** Which host-level panel is open as an overlay, if any. */
const panel = ref<'ports' | 'usage' | null>(null);

/** Session-panel geometry. Collapsed hides it entirely; width is drag-resized. */
const panelCollapsed = ref(false);
const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = 560;
const DEFAULT_PANEL_WIDTH = 280;
const PANEL_WIDTH_KEY = 'pocketshell.sessionPanelWidth';

/**
 * Restore the dragged width. It used to reset to 280 on every mount, so the
 * resize was a per-visit chore rather than a setting. Clamped on read as well
 * as on write: the stored value predates any change to the clamp, and a
 * hand-edited or corrupt entry must not be able to strand the panel offscreen.
 */
function loadPanelWidth(): number {
  const stored = Number.parseInt(window.localStorage.getItem(PANEL_WIDTH_KEY) ?? '', 10);
  if (Number.isNaN(stored)) return DEFAULT_PANEL_WIDTH;
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, stored));
}

const panelWidth = ref(loadPanelWidth());

/** Session named by the route, so the panel can highlight the current row. */
const activeSession = computed(() => (route.params['session'] as string | undefined) ?? null);

function onSelectSession(session: SessionSummary): void {
  if (session.name === activeSession.value) return;
  // `void`: vue-router rejects the returned promise on an aborted or
  // redirected navigation, and neither is an error here. Same convention as
  // src/main/index.ts's `void mainWindow.loadURL(...)`.
  void router.push({
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
  // Written once per drag, not per mousemove: this is a preference, and a
  // localStorage write on every pointer sample is a synchronous disk touch
  // inside the drag loop.
  window.localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth.value));
}

onBeforeUnmount(onDragEnd);

async function onDisconnect(): Promise<void> {
  await connection.disconnect();
  void router.push({ name: 'hosts' });
}

function onBack(): void {
  void router.push({ name: 'hosts' });
}

/**
 * The usage panel's refresh lives in the OVERLAY header, beside the close
 * control, rather than floating at the top of the panel body where it read as
 * orphaned debris. The overlay owns the chrome, so the host owns this button.
 */
async function onRefreshUsage(): Promise<void> {
  if (connection.connectionId) await agents.loadUsage(connection.connectionId);
}
</script>

<template>
  <div class="workspace">
    <header class="topbar">
      <button class="icon-btn" title="Back to hosts" @click="onBack">
        <AppIcon name="arrow-left" />
      </button>
      <button
        class="icon-btn"
        :title="panelCollapsed ? 'Show session panel' : 'Hide session panel'"
        @click="panelCollapsed = !panelCollapsed"
      >
        <!-- VS Code's "toggle sidebar" mark: truer to the action than a
             hamburger, which promises a menu. -->
        <AppIcon name="panel-left" />
      </button>
      <span class="host-label">
        {{ connection.activeHost?.name ?? 'host' }}
        <span class="muted">·</span>
        <span class="muted">{{ connection.activeHost?.user }}@{{ connection.activeHost?.hostname }}</span>
      </span>
      <span v-if="connection.bootstrap" class="bootstrap">
        <span :class="['chip', connection.bootstrap.pocketshell.installed ? 'ok' : 'warn']">
          pocketshell
          <AppIcon
            :name="connection.bootstrap.pocketshell.installed ? 'check' : 'close'"
            :size="12"
          />
        </span>
        <span :class="['chip', connection.bootstrap.tmux.installed ? 'ok' : 'warn']">
          tmux
          <AppIcon :name="connection.bootstrap.tmux.installed ? 'check' : 'close'" :size="12" />
        </span>
      </span>
      <div class="host-actions">
        <button class="btn-ghost" title="Port forwarding" @click="panel = 'ports'">Ports</button>
        <button class="btn-ghost" title="Provider usage" @click="panel = 'usage'">Usage</button>
        <button class="btn-ghost disconnect" @click="onDisconnect">disconnect</button>
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
    <OverlayPanel v-if="panel === 'usage'" title="Provider usage" size="md" @close="panel = null">
      <template #actions>
        <button
          class="icon-btn"
          :disabled="agents.loading"
          title="Refresh"
          @click="onRefreshUsage"
        >
          <AppIcon name="refresh" :class="{ spin: agents.loading }" />
        </button>
      </template>
      <!-- `embedded`: the overlay header renders the title AND the refresh. -->
      <UsageView v-if="connection.connectionId" embedded />
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
  gap: var(--sp-2);
  height: var(--topbar-h);
  flex: 0 0 auto;
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.host-label {
  font-weight: var(--fw-semibold);
  font-size: var(--fs-400);
  line-height: var(--lh-400);
  margin-left: var(--sp-1);
}
.host-label .muted {
  font-weight: var(--fw-regular);
  font-size: var(--fs-200);
  font-family: var(--font-mono);
}
.bootstrap {
  display: flex;
  gap: var(--sp-1);
}
/* One badge metric across the app (docs/POLISH.md §7); the inline-flex is
   also what centres the state icon against the label. */
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-100);
  line-height: var(--lh-100);
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
}
.chip.ok {
  color: var(--success);
  background: var(--success-soft);
}
.chip.warn {
  color: var(--warning);
  background: var(--warning-soft);
}
.host-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  margin-left: auto;
}
/* Destructive: neutral at rest, error-tinted only on hover. No border-color
   line — the button is a ghost now and has no border to tint. */
.btn-ghost.disconnect:hover:not(:disabled) {
  background: var(--error-soft);
  color: var(--error);
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
/* Transparent at rest: the session panel's own 1px right border is the visual
   seam, and the 4px --bg band this used to paint read as a dark gutter
   doubling that hairline. VS Code's sash behaviour, including the hover-in
   delay — the highlight appears only when the cursor LINGERS, so sweeping
   across the app never flashes a cyan bar. The delay is enter-only; leaving
   transitions immediately. */
.splitter {
  flex: 0 0 auto;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background var(--dur-fast) var(--ease);
}
.splitter:hover {
  background: var(--accent-dim);
  transition-delay: 250ms;
}
/* No border-left here: SessionTree already draws the panel's right hairline
   and the splitter sits between them. */
.session-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
