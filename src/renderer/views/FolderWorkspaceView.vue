<script setup lang="ts">
// FolderWorkspaceView: everything scoped to ONE project FOLDER, rendered in
// the host workspace's right pane. It replaces SessionWorkspaceView, which was
// scoped to one session. See docs/WORKSPACE.md.
//
// The tab bar is the whole idea:
//
//   [ main ] [ import ] [ Terminal 2 ] [ Files ] [+]
//
// one tab per tmux session in the folder, then one or more Files tabs, session
// tabs first. A session tab IS a terminal — there is no sub-navigation inside
// one, because the Conversation view that used to compete for that space has
// been deleted (docs/WORKSPACE.md §9).
//
// Four structural notes, three of them inherited from the view this replaces
// because the reasons have not changed:
//
//   - ONE TerminalView, re-pointed, not one per session tab. Main keeps a
//     single attached tmux client per connection and moves it with
//     `switch-client` (src/main/ssh/TmuxClientPool.ts), so a second live
//     TerminalView would be two components fighting over one client. Switching
//     session tabs therefore changes `session-key`, which is exactly the path
//     the pool's fast switch was built for.
//   - The terminal stays mounted (`v-show`, not `v-if`) while a Files tab is
//     showing; unmounting it would close the SSH shell and drop the attach.
//   - Identity and tabs share ONE bar, for the 40px of window it gives back to
//     the pane.
//   - `.workspace-body` is the composer's stage: the card floats over the tab
//     content inside it rather than docking below, so no composer state can
//     change the terminal's row count.
//
// The composer is mounted ONCE, outside `.tab-body` and never behind a `v-if`,
// so a tab switch cannot cost a draft. It follows the ACTIVE SESSION TAB — its
// per-session record is keyed on the session name, so switching session tabs
// swaps the draft and switching back restores it (docs/WORKSPACE.md §8).
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../ipc';
import { useConnectionStore } from '../stores/connection';
import { useSessionsStore } from '../stores/sessions';
import { useProjectsStore } from '../stores/projects';
import { useFilesStore } from '../stores/files';
import { useComposerStore } from '../stores/composer';
import { useSettingsStore } from '../stores/settings';
import { useShellsStore } from '../stores/shells';
import AppIcon from '../components/AppIcon.vue';
import TerminalView from '../components/TerminalView.vue';
import PromptComposer from '../components/PromptComposer.vue';
import FilesView from './FilesView.vue';
import { composerAgentKind } from '../../shared/composerSend';
import { sanitisePart, sessionBaseName } from '../../shared/sessionNameParts';
import {
  buildWorkspaceTabs,
  renamedSessionName,
  type WorkspaceTab,
} from '../../shared/workspaceTabs';
import { groupSessionsIntoRoots, UNTRACKED_PATH } from '../sessionGrouping';
import type { SessionAgentKind } from '../../shared/types';

const route = useRoute();
const router = useRouter();
const connection = useConnectionStore();
const sessions = useSessionsStore();
const projects = useProjectsStore();
const files = useFilesStore();
const composer = useComposerStore();
const settings = useSettingsStore();
const shells = useShellsStore();

/**
 * Per-workspace UI state that must survive leaving and coming back: which
 * Files tabs are open, and which tab was selected.
 *
 * Module-scoped rather than a Pinia store, deliberately. It is view state with
 * exactly one reader — this component — and no action anywhere else in the app
 * needs to read or write it. A store would buy nothing but a file, and the
 * thing that genuinely IS shared (each Files tab's browsing position) already
 * lives in the files store, keyed by the tab id this map hands out.
 *
 * Keyed by connection AND folder, so one host's tabs cannot appear on another.
 * It is never pruned: an entry is two small strings, and the alternative is a
 * teardown hook that has to guess when a workspace will not be revisited.
 */
interface WorkspaceMemory {
  filesTabs: string[];
  activeTab: string | null;
}
const memory = new Map<string, WorkspaceMemory>();

/** The folder key from the route — `~/git/dtc-website`. */
const folderKey = computed(() => String(route.params['folder'] ?? ''));

const memoryKey = computed(() => `${connection.connectionId ?? 'none'}/${folderKey.value}`);

function remembered(): WorkspaceMemory {
  const existing = memory.get(memoryKey.value);
  if (existing) return existing;
  // Exactly one Files tab to start with. The user asked for "a tab for
  // inspecting files, and we can also have multiple tabs" — one is the tab,
  // the rest are opened on purpose.
  const fresh: WorkspaceMemory = { filesTabs: [`${folderKey.value}::files:1`], activeTab: null };
  memory.set(memoryKey.value, fresh);
  return fresh;
}

const filesTabs = ref<string[]>([]);
/** Which tab id is selected. Null means "the first one", resolved on read. */
const selected = ref<string | null>(null);

/**
 * The folder node this workspace is showing, out of the same grouping the
 * panel renders.
 *
 * Deriving it from the grouping rather than by filtering sessions on `path`
 * is what keeps the two in agreement: the grouping is where `~/git/foo` and
 * `/home/me/git/foo` are folded into one key, where a session with no cwd
 * becomes a folder of its own, and where a sibling-inferred path has already
 * been applied. A second, simpler filter here would disagree with the panel on
 * every one of those and the symptom would be a folder row that opens an empty
 * workspace.
 */
const folder = computed(() => {
  const home = projects.home;
  for (const root of groupSessionsIntoRoots(sessions.sessions, home, settings.sessionRoots)) {
    const match = root.directories.find((dir) => dir.key === folderKey.value);
    if (match) return match;
  }
  return null;
});

/** The folder's real path, or null for an untracked session's pseudo-folder. */
const folderPath = computed(() => {
  const path = folder.value?.path ?? folderKey.value;
  return path === UNTRACKED_PATH ? null : path;
});

/**
 * The prefix the tab labels strip (docs/WORKSPACE.md §3.3).
 *
 * `sessionBaseName` is the SAME function the main process derives a new
 * session's name with — that is why it was moved into `shared/`. Deriving the
 * prefix any other way (the sessions' literal common prefix, say) would make
 * the labels depend on which sessions happen to be running rather than on the
 * folder, and would relabel a session that was never named after this folder
 * at all.
 *
 * The key is home-relative (`~/git/foo`), so it is expanded before derivation
 * when `$HOME` is known. When it is not, `sessionBaseName` handles the `~/`
 * form directly and produces the same answer for everything under home — the
 * one case it gets wrong without `$HOME` is the home directory ITSELF, whose
 * real name is `home-<basename>`.
 */
const prefix = computed(() => {
  const key = folderKey.value;
  const home = projects.home;
  if (home && key === '~') return sessionBaseName(home, home);
  if (home && key.startsWith('~/')) return sessionBaseName(`${home}/${key.slice(2)}`, home);
  return sessionBaseName(key, home);
});

const tabs = computed<WorkspaceTab[]>(() =>
  buildWorkspaceTabs(
    (folder.value?.rows ?? []).map((row) => ({
      name: row.session.name,
      created: row.session.created,
    })),
    prefix.value,
    filesTabs.value.map((id) => ({ id, path: folderPath.value })),
  ),
);

/** The selected tab, falling back to the first one the bar has. */
const activeTab = computed<WorkspaceTab | null>(() => {
  const found = tabs.value.find((tab) => tab.id === selected.value);
  return found ?? tabs.value[0] ?? null;
});

/** The session the composer and the terminal are pointed at, if any. */
const activeSession = computed(() =>
  activeTab.value?.kind === 'session' ? activeTab.value.session : null,
);

/** The session tab that is (or was last) showing — what the terminal holds. */
const terminalSession = ref<string | null>(null);
watch(
  activeSession,
  (name) => {
    if (name) terminalSession.value = name;
  },
  { immediate: true },
);

const summary = computed(
  () => sessions.sessions.find((s) => s.name === terminalSession.value) ?? null,
);

/**
 * The engine recorded host-side for the active session, narrowed to what the
 * composer can route to. An agent session gets the slash-command catalog, a
 * shell never does (docs/COMPOSER.md §18).
 */
const agentKind = computed(() => composerAgentKind(summary.value?.agentKind));

/** Header tooltip: the folder's path, plus why it is only a guess when it is. */
const folderTitle = computed(() => {
  const lines = [folderPath.value ?? 'no reported folder'];
  if (folder.value?.rows.some((row) => row.session.pathInferred)) {
    lines.push('folder inferred from the session name, not reported by tmux');
  }
  return lines.join('\n');
});

/**
 * Load this folder's remembered tabs into the live refs.
 *
 * Called from `onMounted` AND from a watch on the folder key, because
 * vue-router REUSES this component instance when only the `:folder` param
 * changes — `onMounted` does not fire on a folder-to-folder navigation, and
 * without the watch the second folder would inherit the first one's Files tabs
 * and selection.
 */
function loadFolderState(): void {
  const state = remembered();
  filesTabs.value = state.filesTabs;
  selected.value = (route.query['tab'] as string | undefined) ?? state.activeTab;
}

/**
 * Write the tab state back.
 *
 * Called explicitly by the four things that change it rather than from a watch
 * on the refs. A watch would fire during a folder switch, between the key
 * changing and the refs being reloaded, and would stamp the OUTGOING folder's
 * tabs onto the incoming folder's memory entry.
 */
function persist(): void {
  memory.set(memoryKey.value, {
    filesTabs: [...filesTabs.value],
    activeTab: selected.value,
  });
}

onMounted(async () => {
  loadFolderState();
  // Deep-linking straight to a folder (or a reload) can leave the stores empty,
  // and BOTH matter here: without the session list there are no tabs at all,
  // and without `$HOME` the label prefix is derived from the `~/` form.
  if (connection.connectionId) {
    if (!sessions.sessions.length) await sessions.refresh(connection.connectionId);
    await projects.ensureHome(connection.connectionId);
  }
});

watch(folderKey, () => {
  cancelRename();
  addMenuOpen.value = false;
  createError.value = null;
  loadFolderState();
});

/**
 * A path clicked in the terminal brings a Files tab forward.
 *
 * The store only PARKS the request; FilesView takes it in its own onMounted,
 * after `files.open()` has restored the remembered directory. Whichever Files
 * tab is already selected takes it, and when none is, the first one does —
 * revealing into the tab the user last used beats opening a new one for every
 * click.
 */
watch(
  () => files.reveal,
  (target) => {
    if (target == null) return;
    if (activeTab.value?.kind === 'files') return;
    const first = tabs.value.find((tab) => tab.kind === 'files');
    if (first) {
      selected.value = first.id;
      persist();
    }
  },
);

function selectTab(tab: WorkspaceTab): void {
  if (tab.id === selected.value || tab.id === activeTab.value?.id) {
    // A click on the tab that is ALREADY current starts a rename, which is what
    // makes "if I click on the tab I can rename it" coexist with "if I click on
    // the tab I switch to it" — the browser/VS Code contract. Files tabs have
    // no name on the host, so they are not renameable.
    if (tab.kind === 'session') beginRename(tab);
    return;
  }
  selected.value = tab.id;
  persist();
  if (tab.kind === 'session') {
    // A dismissal ("leave me alone") should not follow the user into a
    // different session, which is a different pane and very often a different
    // intent. Deliberately NOT done for a Files tab: the composer is not
    // showing there, so there is no dismissal to reconsider.
    composer.allowTypingToOpen();
  }
}

// ---------------------------------------------------------------------------
// Rename (docs/WORKSPACE.md §4)
// ---------------------------------------------------------------------------
/** The tab being renamed, and the text in its field. */
const renaming = ref<{ id: string; session: string; remainder: string | null } | null>(null);
const renameText = ref('');
const renameError = ref<string | null>(null);

function beginRename(tab: WorkspaceTab): void {
  if (tab.kind !== 'session') return;
  renaming.value = { id: tab.id, session: tab.session, remainder: tab.remainder };
  // The field edits the LABEL, and for a derived name the label is the
  // remainder — so what is in the box is the part that is actually the user's
  // to change. A non-derived name has no prefix to re-apply, so it edits whole.
  renameText.value = tab.remainder ?? tab.session;
  renameError.value = null;
}

function cancelRename(): void {
  renaming.value = null;
  renameError.value = null;
}

/**
 * Strip illegal characters AS THE USER TYPES, with the same sanitiser the host
 * will apply. What is on screen is then what the session will be called, so a
 * rename never silently produces a different name from the one that was typed.
 */
function onRenameInput(event: Event): void {
  const el = event.target as HTMLInputElement;
  const cleaned = sanitisePart(el.value);
  if (cleaned !== el.value) el.value = cleaned;
  renameText.value = cleaned;
}

async function commitRename(): Promise<void> {
  const target = renaming.value;
  const connectionId = connection.connectionId;
  if (!target || !connectionId) return cancelRename();

  const next = renamedSessionName(renameText.value, prefix.value, target.remainder, sanitisePart);
  if (next === null) {
    renameError.value = 'that leaves nothing a session can be called';
    return;
  }
  if (next === target.session) return cancelRename();

  const result = await projects.renameSession(connectionId, target.session, next);
  if (!result.ok || !result.sessionName) {
    renameError.value = result.error ?? 'rename failed';
    return;
  }
  // The composer's per-session record is keyed on the name, so it has to move
  // or the draft is orphaned under a key nothing will ever ask for again.
  composer.rekey(
    composer.targetKey(connectionId, target.session),
    composer.targetKey(connectionId, result.sessionName),
  );
  selected.value = result.sessionName;
  terminalSession.value = result.sessionName;
  persist();
  cancelRename();
  await sessions.refresh(connectionId);
}

// ---------------------------------------------------------------------------
// Creating a session in this folder (docs/WORKSPACE.md §5)
// ---------------------------------------------------------------------------
/** The engines the `+` menu offers, plus a plain shell. */
const AGENT_CHOICES: { kind: SessionAgentKind | null; label: string }[] = [
  { kind: 'claude', label: 'Claude Code' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'opencode', label: 'OpenCode' },
  { kind: 'grok', label: 'Grok' },
  { kind: null, label: 'Shell' },
];

const addMenuOpen = ref(false);
const createError = ref<string | null>(null);

/**
 * A launch waiting for its session's PTY to exist.
 *
 * The desktop cannot set `@ps_agent_kind` — the helper's `pocketshell agent`
 * wrapper writes it in the process that BECOMES the agent (docs/ANALYSIS.md).
 * So choosing an engine means starting a session and then running the wrapper
 * inside it, which cannot happen until the terminal has actually attached. The
 * watch below is that wait; it is one-shot, and a session whose PTY never comes
 * up simply gets a shell, which is what it would have been anyway.
 */
const pendingLaunch = ref<{ session: string; kind: SessionAgentKind } | null>(null);

watch(
  () => (pendingLaunch.value ? shells.shellIdFor(pendingLaunch.value.session) : null),
  (shellId) => {
    const pending = pendingLaunch.value;
    if (!pending || !shellId) return;
    pendingLaunch.value = null;
    // Through the wrapper, never the bare `claude`/`codex` binary: the wrapper
    // is what records the kind, and a session started around it shows up as
    // `unknown` forever.
    void api.shell.input(shellId, `pocketshell agent ${pending.kind}\r`);
  },
);

async function createSession(kind: SessionAgentKind | null): Promise<void> {
  addMenuOpen.value = false;
  createError.value = null;
  const connectionId = connection.connectionId;
  const path = folderPath.value;
  if (!connectionId || !path) {
    createError.value = 'this folder has no known directory on the host';
    return;
  }
  // `unique` and not `reuse`: the folder's default session already has a tab,
  // so "new session" here can only mean a genuinely new one. The host walks
  // `<base>-2`, `<base>-3`, which is what makes the new tab read `Terminal 2`.
  const result = await projects.start(connectionId, path, undefined, 'unique');
  if (!result.ok || !result.sessionName) {
    createError.value = result.error ?? 'could not start a session here';
    return;
  }
  if (kind) pendingLaunch.value = { session: result.sessionName, kind };
  await sessions.refresh(connectionId);
  selected.value = result.sessionName;
  persist();
}

/** Another Files tab, with its own directory memory (docs/WORKSPACE.md §3.5). */
function addFilesTab(): void {
  addMenuOpen.value = false;
  // Monotonic within the workspace, never a length-derived index: closing tab 2
  // and adding one would otherwise reuse its id and inherit its directory.
  const next = `${folderKey.value}::files:${Date.now()}`;
  filesTabs.value = [...filesTabs.value, next];
  selected.value = next;
  persist();
}

function closeFilesTab(id: string): void {
  filesTabs.value = filesTabs.value.filter((tab) => tab !== id);
  if (selected.value === id) selected.value = null;
  persist();
}

/** Deselect: back to the right pane's empty state, panel untouched. */
function onCloseFolder(): void {
  // `void`: vue-router rejects on aborted/redirected navigation, neither of
  // which is an error here.
  void router.push({ name: 'host-sessions', params: { name: route.params['name'] as string } });
}

// ---------------------------------------------------------------------------
// Terminal / composer plumbing — unchanged from the per-session workspace
// ---------------------------------------------------------------------------
/**
 * Template ref on the terminal, so the composer's Escape ladder can un-focus.
 * Typed by the one method we call rather than `InstanceType<typeof
 * TerminalView>`: `*.vue` is declared as a `DefineComponent<…, any>` in
 * env.d.ts, so that instance type collapses to `any` and takes the call site
 * with it.
 */
const terminalRef = ref<{ focus: () => void } | null>(null);
/** Same reasoning for the composer, whose `typeInto` the terminal feeds. */
const composerRef = ref<{ typeInto: (text: string) => void } | null>(null);

/**
 * Whether the terminal should withhold printable keystrokes instead of sending
 * them to the shell (docs/COMPOSER.md §26). The two halves of the condition
 * live here rather than in either component: the SETTING is app-level, and
 * "only while the composer is closed" is a fact about the composer.
 */
const interceptTyping = computed(
  () =>
    settings.typingOpensComposer &&
    composer.mode === 'hidden' &&
    // A user who dismissed the composer asked for a plain terminal, and this is
    // the only way to have one while the setting is on (§12.2).
    !composer.typingSuppressed &&
    activeTab.value?.kind === 'session',
);

/** A keystroke the terminal withheld: it belongs in the draft, not the shell. */
function onTyped(text: string): void {
  composerRef.value?.typeInto(text);
}

/** Put the keyboard back in the pane after a key or button closed the composer. */
function onFocusTerminal(): void {
  if (activeTab.value?.kind !== 'session') return;
  terminalRef.value?.focus();
}

</script>

<template>
  <div class="folder-workspace">
    <!-- ONE row of chrome, not two. The tabs come first because they are the
         only thing here that gets clicked, and a leading identity label of
         unpredictable length would move them horizontally on every folder
         change. The folder name trails, where it is read rather than aimed at,
         and truncates before the tabs ever do. -->
    <header class="folder-bar">
      <nav class="tabs">
        <template v-for="tab in tabs" :key="tab.id">
          <!-- The rename field REPLACES the tab in place rather than opening a
               dialog: the thing being renamed is the thing under the cursor,
               and a modal for a one-word edit is a heavier promise than the
               edit deserves. -->
          <span v-if="renaming?.id === tab.id" class="tab renaming">
            <input
              class="rename-input"
              :value="renameText"
              :title="renameError ?? 'Enter to rename, Escape to cancel'"
              :class="{ invalid: renameError }"
              autofocus
              @input="onRenameInput"
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename"
            />
          </span>
          <button
            v-else
            :class="['tab', { active: tab.id === activeTab?.id, files: tab.kind === 'files' }]"
            :title="
              tab.kind === 'session'
                ? `${tab.session}\nclick again to rename`
                : 'File browser'
            "
            @click="selectTab(tab)"
          >
            {{ tab.label }}
            <!-- Only a SECOND Files tab is closable. The first is the folder's
                 file browser and closing it would leave a workspace with no way
                 to look at the folder at all; a session tab is not closable
                 here at any count, because closing it would have to mean
                 killing a live tmux session and that is not what a tab close
                 means anywhere else. -->
            <span
              v-if="tab.kind === 'files' && filesTabs.length > 1"
              class="tab-close"
              title="Close this Files tab"
              @click.stop="closeFilesTab(tab.id)"
            >
              <AppIcon name="close" :size="12" />
            </span>
          </button>
        </template>

        <div class="add-wrap">
          <button class="tab add" title="New session or Files tab" @click="addMenuOpen = !addMenuOpen">
            <AppIcon name="plus" :size="14" />
          </button>
          <!-- A menu rather than the folder-first dialog: that dialog exists to
               CHOOSE a folder, and inside a folder workspace the folder is
               already chosen. What is left to choose is the engine. -->
          <ul v-if="addMenuOpen" class="add-menu">
            <li class="add-menu-head">New session</li>
            <li v-for="choice in AGENT_CHOICES" :key="choice.label">
              <button class="add-menu-item" @click="createSession(choice.kind)">
                {{ choice.label }}
              </button>
            </li>
            <li class="add-menu-sep" />
            <li>
              <button class="add-menu-item" @click="addFilesTab">New Files tab</button>
            </li>
          </ul>
        </div>
      </nav>

      <span class="folder-name" :title="folderTitle">{{ folder?.label ?? folderKey }}</span>

      <button class="icon-btn close" title="Close folder" @click="onCloseFolder">
        <AppIcon name="close" />
      </button>
    </header>

    <p v-if="createError" class="bar-error">{{ createError }}</p>

    <div class="workspace-body">
      <div class="tab-body">
        <!-- Terminal: kept mounted so switching to a Files tab never drops the
             attach. `session-key` is what re-points it, which is the same path
             the pool's fast switch was built for. -->
        <div v-show="activeTab?.kind === 'session'" class="terminal-area">
          <TerminalView
            v-if="connection.connectionId && terminalSession"
            ref="terminalRef"
            :connection-id="connection.connectionId"
            :session-key="terminalSession"
            :intercept-typing="interceptTyping"
            @typed="onTyped"
          />
        </div>

        <FilesView
          v-if="activeTab?.kind === 'files' && connection.connectionId"
          :key="activeTab.id"
          :start-path="folderPath ?? undefined"
          :session-key="activeTab.id"
        />

        <!-- No tabs at all: the folder's sessions were killed while this was
             open, or a deep link outlived them. There is exactly one useful
             thing to do here, so the empty state IS the create affordance. -->
        <div v-if="!tabs.length" class="empty">
          <p class="muted">{{ folderPath ?? folderKey }}</p>
          <p class="muted">nothing is running in this folder</p>
          <button class="btn-ghost" @click="createSession(null)">Start a session here</button>
        </div>
      </div>

      <!-- The prompt composer FLOATS over the tab content rather than docking
           below it. Mounted once, v-show (never v-if) so a tab switch cannot
           cost the user a draft. It follows the ACTIVE SESSION TAB. -->
      <div
        v-if="connection.connectionId && activeSession"
        v-show="activeTab?.kind === 'session'"
        class="composer-dock"
      >
        <PromptComposer
          ref="composerRef"
          :connection-id="connection.connectionId"
          :session-name="activeSession"
          :agent-kind="agentKind"
          :connected="connection.state === 'connected'"
          @focus-terminal="onFocusTerminal"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.folder-workspace {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;

  /* The gap between the floating composer and this pane's edges — what makes
     it read as hovering rather than as a bar welded to the window. Declared
     here rather than in App.vue's :root because it describes THIS pane's
     relationship with the composer, and custom properties inherit, so
     PromptComposer reads the same number without being handed it. */
  --composer-inset: var(--sp-3);
}
/* ---- one row of chrome ---------------------------------------------------
 * Identity and tabs used to be two full-height bars, 72px of chrome above every
 * terminal. Merged they cost --topbar-h and nothing else.
 *
 * The row has no vertical padding on purpose. The tabs are full-height children
 * of it, which is what lets the active tab's 2px underline sit exactly on the
 * row's own bottom border — the treatment DESIGN.md §5.4 specifies.
 */
.folder-bar {
  display: flex;
  align-items: stretch;
  gap: var(--sp-3);
  height: var(--topbar-h);
  flex: 0 0 auto;
  padding: 0 var(--sp-3) 0 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
/* Takes the slack, so the name sits hard against the close button rather than
   drifting with the tab labels' length. */
.folder-name {
  flex: 1 1 auto;
  min-width: 0;
  align-self: center;
  text-align: right;
  font-family: var(--font-mono);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  font-weight: var(--fw-medium);
  color: var(--fg-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.close {
  align-self: center;
  flex-shrink: 0;
}
/* Underline tabs, not Android's filled segmented control: a solid cyan
   segment at 13px is heavy for a mouse UI. See DESIGN.md §5.4.
   The bar scrolls rather than wrapping: a second row of tabs would change the
   terminal's height, which is a remote tmux reflow (see .tab-body). */
.tabs {
  display: flex;
  align-items: stretch;
  gap: var(--sp-1);
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 0 0 0 var(--sp-3);
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  background: transparent;
  border: none;
  /* The 2px underline lands on the bar's bottom border because the button is
     the bar's full height; the -1px pulls it over that hairline instead of
     stacking a second line under it. */
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  color: var(--fg-secondary);
  padding: 0 var(--sp-3);
  cursor: pointer;
  white-space: nowrap;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  transition:
    color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
.tab:hover {
  color: var(--fg);
}
.tab.active {
  color: var(--fg);
  font-weight: var(--fw-semibold);
  border-bottom-color: var(--accent);
}
/* Files tabs are the same control at a lower tone, so the eye can find the
   session half of the bar without reading it. */
.tab.files {
  font-family: var(--font-ui);
  color: var(--fg-muted);
}
.tab.files.active {
  color: var(--fg);
}
.tab-close {
  display: inline-flex;
  align-items: center;
  color: var(--fg-muted);
  border-radius: var(--r-sm);
}
.tab-close:hover {
  color: var(--fg);
  background: var(--state-hover);
}
/* The field takes the tab's own box, so committing a rename does not make the
   bar jump: the tab it replaces was the same height and roughly the same
   width. */
.tab.renaming {
  display: inline-flex;
  align-items: center;
  padding: 0 var(--sp-2);
  border-bottom: 2px solid var(--accent);
  margin-bottom: -1px;
}
.rename-input {
  width: 10ch;
  min-width: 6ch;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-300);
  padding: 0 var(--sp-1);
}
.rename-input.invalid {
  border-color: var(--error);
}
.add-wrap {
  position: relative;
  display: flex;
  align-items: stretch;
}
.tab.add {
  color: var(--fg-muted);
}
/* Anchored to the `+` rather than centred: it is a continuation of the control
   that opened it, and a menu that appears somewhere else has to be re-found. */
.add-menu {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 20;
  list-style: none;
  margin: var(--sp-1) 0 0;
  padding: var(--sp-1);
  min-width: 160px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: 0 8px 24px var(--scrim);
}
.add-menu-head {
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-muted);
}
.add-menu-sep {
  height: 1px;
  margin: var(--sp-1) 0;
  background: var(--border);
}
.add-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg);
  padding: var(--sp-1) var(--sp-2);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
}
.add-menu-item:hover {
  background: var(--state-hover);
}
/* A failed create is a sentence, not a dialog: the tab bar is still usable and
   the message is about the one action that did not happen. */
.bar-error {
  margin: 0;
  padding: var(--sp-1) var(--sp-3);
  color: var(--error);
  background: var(--error-soft);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
.workspace-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  /* Containing block for .composer-dock, which is positioned against it. */
  position: relative;
}
/*
 * NO ROOM IS RESERVED FOR THE COMPOSER, and the terminal is sized once by the
 * pane. That is what keeps opening, closing, dragging and resizing the card
 * free of an SSH window-change and a remote tmux reflow. See the same block in
 * the view this replaced; the reasoning is unchanged.
 */
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
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  font-size: var(--fs-300);
}
.empty p {
  margin: 0;
}

/* ---- the composer floats over the tab content --------------------------- */
/*
 * Why an overlay and not a docked row: docked, the composer was a flex sibling
 * of the tab body, so every open, close and resize changed the terminal's pixel
 * height — which changes its ROW COUNT, which is an SSH window-change the
 * remote tmux has to redraw and reflow for. Typing a prompt should not reflow
 * the session behind it.
 *
 * Why the dock is the WHOLE body and not a strip at the bottom: because the
 * card MOVES. Every clamp in src/shared/composerGeometry.ts is measured against
 * this element.
 */
.composer-dock {
  position: absolute;
  /* INSET rather than padded. An absolutely positioned child resolves its
     offsets against its containing block's PADDING box, so padding here would
     not have held the card off the pane's edges — and insetting the dock itself
     makes `right: 0; bottom: 0` mean "the resting corner". */
  inset: var(--composer-inset);
  z-index: 5;
  pointer-events: none;
}
</style>
