<script setup lang="ts">
// Host workspace: the shell for a connected host.
//
// Layout: a persistent left panel holding the folder-grouped session list,
// and a right pane showing the selected FOLDER's workspace. The panel never
// goes away — picking a folder only swaps what the right pane renders:
//
//   /host/:name                -> SessionPlaceholderView (nothing selected)
//   /host/:name/folder/:folder -> FolderWorkspaceView (a tab per session, then Files)
//
// There is deliberately NO host topbar. The row that used to sit here —
// back, collapse, `hetzner · alexey@135.181.114.209`, Ports/Usage/Settings,
// disconnect — spent a full --topbar-h above every terminal mostly on an
// identity label, in an app whose whole point is the terminal. It went four
// ways (docs/DESIGN.md §5.3b):
//
//   - the IDENTITY is the OS window title now (the `win:setTitle` watch
//     below) — the native title bar was already there, saying "PocketShell";
//   - BACK and COLLAPSE moved into the session panel's own header row, which
//     was already paying for its --topbar-h;
//   - PORTS / USAGE / SETTINGS were a panel-FOOT row, and are now an overflow
//     menu in that same header (docs/DESIGN.md §5.3c) — the user asked for
//     them at the top. The overlays did not move; only their triggers did;
//   - DISCONNECT moved to the host picker's row for the connected host —
//     every disconnect already navigated there, so the button now lives at
//     its own destination, next to where the connection was opened.
//
// Folders are the default view of a host, and tabs belong to the selected
// FOLDER (docs/WORKSPACE.md). The two host-scoped panels — port forwarding and
// provider usage — open as overlays, because neither is a property of one
// folder.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAgentsStore } from '../stores/agents';
import { useConnectionStore } from '../stores/connection';
import { api } from '../ipc';
import { windowTitle } from '../../shared/windowTitle';
import AppIcon from '../components/AppIcon.vue';
import OverlayPanel from '../components/OverlayPanel.vue';
import SessionTree from '../components/SessionTree.vue';
import HostActionsMenu from '../components/HostActionsMenu.vue';
import { type HostPanel } from '../hostPanels';
import type { Box } from '../../shared/popupPlacement';
import PortPanelView from './PortPanelView.vue';
import SettingsView from './SettingsView.vue';
import UsageView from './UsageView.vue';
import type { SessionDirectory } from '../sessionGrouping';

const route = useRoute();
const router = useRouter();
const connection = useConnectionStore();
const agents = useAgentsStore();

/**
 * The host's identity, projected into the OS title bar. Watched rather than
 * set once: a reconnect can swap `activeHost` while this view stays mounted.
 * There is deliberately no reset on unmount — the picker claims the title in
 * its own onMounted, so the handoff cannot depend on Vue's mount/unmount
 * ordering during a route swap.
 */
watch(
  () => connection.activeHost,
  (host) => api.win.setTitle(windowTitle(host)),
  { immediate: true },
);

/**
 * Which panel is open as an overlay, if any.
 *
 * `settings` is the odd one out and is here anyway: it is APP-level, not
 * host-level, so it does not belong to this workspace the way Ports and Usage
 * do. But a route would unmount this view and take the terminal's scrollback
 * with it, and the panel has to be reachable from a connected host as well as
 * from the picker. One shared `SettingsView`, two callers, no navigation. See
 * the header comment in views/SettingsView.vue.
 */
const panel = ref<HostPanel | null>(null);

/**
 * The COLLAPSED RAIL's copy of the host-actions trigger.
 *
 * A second anchor rather than a shared one, because the two triggers are never
 * on screen together — the rail replaces the panel — and threading one piece of
 * state through both would mean the panel's header owning a control that is not
 * rendered while the rail is showing.
 */
const railMenuAnchor = ref<Box | null>(null);
const railMenuButton = ref<HTMLElement | null>(null);

function toggleRailMenu(): void {
  if (railMenuAnchor.value) {
    railMenuAnchor.value = null;
    return;
  }
  const box = railMenuButton.value?.getBoundingClientRect();
  if (box) {
    railMenuAnchor.value = { left: box.left, top: box.top, width: box.width, height: box.height };
  }
}

function onRailPanel(name: HostPanel): void {
  railMenuAnchor.value = null;
  panel.value = name;
}

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

/**
 * The host tools that are not installed.
 *
 * `tmuxctl` is listed like the others but it is not like the others: it is
 * the binary the session-join command invokes, and the raw `tmux attach` and
 * `pocketshell sessions` fallbacks are gone, so a host without it can open no
 * session at all. Naming it here is the difference between finding that out
 * now and finding it out after clicking a session and getting a diagnostic in
 * the terminal.
 */
const missingTools = computed(() => {
  const b = connection.bootstrap;
  if (!b) return [];
  return (['pocketshell', 'tmuxctl', 'tmux'] as const).filter((t) => !b[t].installed);
});

/** "tmuxctl", "tmuxctl and tmux", "pocketshell, tmuxctl and tmux". */
const missingToolsText = computed(() => {
  const names = missingTools.value;
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
});

/** Folder named by the route, so the panel can highlight the current row. */
const activeFolder = computed(() => (route.params['folder'] as string | undefined) ?? null);

/**
 * Open a folder's workspace. [session] names a tab to arrive on, which the
 * panel supplies only when it has a reason to — a session it just created.
 *
 * Re-selecting the folder that is already open is NOT a no-op when a session
 * is named: that is the create case, where the workspace is already on screen
 * and the point of the navigation is to move to the new tab.
 */
function onSelectFolder(folder: SessionDirectory, session?: string): void {
  if (folder.key === activeFolder.value && session === undefined) return;
  // `void`: vue-router rejects the returned promise on an aborted or
  // redirected navigation, and neither is an error here. Same convention as
  // src/main/index.ts's `void mainWindow.loadURL(...)`.
  void router.push({
    name: 'folder',
    params: { name: route.params['name'] as string, folder: folder.key },
    ...(session === undefined ? {} : { query: { tab: session } }),
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
    <!-- Only rendered when something is actually missing. The always-on
         chip row this replaces spent header space telling the user their
         host was fine, which is the case that needs no words at all. -->
    <p v-if="missingTools.length" class="install-ask">
      <AppIcon name="close" :size="14" />
      <span>
        This host is missing {{ missingToolsText }}. Install
        {{ missingTools.length === 1 ? 'it' : 'them' }} on the host to use PocketShell here.
      </span>
    </p>

    <div class="body">
      <!-- Collapsed: a slim rail, not nothing. With the topbar gone, a
           zero-width collapse would take the expand toggle (and with it every
           host-level control) off the screen entirely; the rail keeps expand
           and back one click away and still returns ~90% of the panel's width
           to the terminal. v-if, not v-show — it must never match a selector
           while the expanded header's twin buttons do. -->
      <aside v-if="panelCollapsed" class="collapsed-rail">
        <button class="icon-btn" title="Show session panel" @click="panelCollapsed = false">
          <AppIcon name="panel-left" :size="14" />
        </button>
        <button class="icon-btn" title="Back to hosts" @click="onBack">
          <AppIcon name="arrow-left" :size="14" />
        </button>
        <!-- The rail exists so host controls are not stranded when the panel is
             hidden (ca79ae2). Now that Ports/Usage/Settings live in the panel
             HEADER rather than its foot, the rail has to carry them too, or
             collapsing the panel would take all three off screen.

             It MIRRORS the header's arrangement rather than inventing its own:
             the overflow control for Ports and Usage, then the gear. Not three
             icons — a 36px rail has no room for text, and inventing a glyph
             apiece for "ports" and "usage" is precisely the memory test
             ca79ae2 refused, so those two keep their words inside the menu. The
             gear is the exception for the same reason it is one in the header:
             it is already this app's settings mark everywhere else.

             The gear is here BECAUSE it left the menu. When Settings was a menu
             row, the rail got it for free from the one overflow button; pulling
             it out of the list would otherwise have made the collapsed panel
             offer strictly less than the expanded one, which is the single
             failure this rail exists to prevent.

             There is no `+` here on purpose. The rail is an ESCAPE HATCH — show
             the panel, go back, reach the host overlays — and creating a
             session is a thing you do while looking at the list you are about
             to add to. One click on the top button brings that list back. -->
        <div class="rail-sep" />
        <button
          ref="railMenuButton"
          class="icon-btn"
          title="Ports, Usage"
          aria-haspopup="menu"
          :aria-expanded="railMenuAnchor !== null"
          @click="toggleRailMenu"
        >
          <AppIcon name="more-horizontal" :size="14" />
        </button>
        <button class="icon-btn" title="Settings" @click="panel = 'settings'">
          <AppIcon name="settings" :size="14" />
        </button>
        <HostActionsMenu
          v-if="railMenuAnchor"
          :anchor="railMenuAnchor"
          :trigger="railMenuButton"
          @select="onRailPanel"
          @close="railMenuAnchor = null"
        />
      </aside>

      <!-- Persistent session panel: always mounted, never navigated away from.
           v-show, not v-if — collapsing must not cost the tree its disclosure
           and scroll state. A flex column: the tree above, host actions below. -->
      <aside
        v-show="!panelCollapsed"
        class="session-panel"
        :style="{ width: `${panelWidth}px` }"
      >
        <!-- The host destinations moved INTO this component's header as an
             overflow menu; it emits which overlay was asked for and this view
             still owns them. -->
        <SessionTree
          :active-folder="activeFolder"
          @select="onSelectFolder"
          @back="onBack"
          @collapse="panelCollapsed = true"
          @panel="panel = $event"
        />
      </aside>
      <div
        v-show="!panelCollapsed"
        class="splitter"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        @mousedown.prevent="onDragStart"
      />

      <!-- Right pane: the selected folder's workspace, or the empty state. -->
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
    <OverlayPanel v-if="panel === 'settings'" title="Settings" size="md" @close="panel = null">
      <SettingsView />
    </OverlayPanel>
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
/* Warning-toned but not an alarm: it is an instruction, and the user can
   still use every other part of the app while it stands. With the topbar gone
   it is the workspace's top strip — rendered only when it applies, so the
   usual cost is zero rows. */
.install-ask {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  color: var(--warning);
  background: var(--warning-soft);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
.body {
  display: flex;
  flex: 1;
  min-height: 0;
}
/* Surface and the right hairline live on the aside, not on SessionTree: the
   panel is a column of [tree, host-actions] and the seam has to run past
   both. The splitter sits just outside it, transparent at rest. */
.session-panel {
  flex: 0 0 auto;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-right: 1px solid var(--border);
}
/* Divides the NAVIGATION half of the rail (show panel, back) from the
   HOST-OVERLAY half, so three icons in a column do not read as one list of
   five unrelated things. */
.rail-sep {
  width: 16px;
  height: 1px;
  margin: var(--sp-1) 0;
  background: var(--border);
}
/* Expand-affordance column for the collapsed state. Same surface and hairline
   as the panel it stands in for. */
.collapsed-rail {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1);
  background: var(--surface);
  border-right: 1px solid var(--border);
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
/* No border-left here: the session panel draws its own right hairline and the
   splitter sits between them. */
.session-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
