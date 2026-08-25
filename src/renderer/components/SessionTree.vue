<script setup lang="ts">
// SessionTree: the live tmux session list for the active connection, as a
// FOLDER VIEW — TWO levels, root then folder, one row per folder
// (docs/WORKSPACE.md §2, revising docs/SESSIONLIST.md revision 3):
//
//   v git                        12
//     dtc-website           2       21h
//     pocketshell           3       21h
//     dataops                       22h
//   > other                         3
//
// ## Why the session level went, and why this is not revision 2 again
//
// Revision 3 made this `root -> folder -> session`, and the load-bearing
// sentence in it was "the directory row is no longer selectable: clicking it
// expands". The session leaf existed because it was the ONLY way to reach a
// session — selecting one was a panel operation, so the panel needed a row per
// session to select. That is no longer true. A folder row opens a folder
// WORKSPACE whose tab bar already carries every session in the folder, always
// visible, one click away, so the leaf now spends a row on a navigation step
// something else already performs.
//
// Revisions 1 and 2 removed the folder header CONDITIONALLY — when a folder
// held one session — which made the panel's shape depend on its contents and
// change under the refresh timer; a tree whose nodes collapse whenever they
// hold one child does not read as a tree. This is the opposite: there is no
// session level for ANY folder, whatever it holds, so the panel is always two
// deep and a reader can predict its shape without knowing what is running.
// SESSIONLIST §1's measurement is not overturned — it said a level must earn
// its rows, and this one no longer does.
//
// An untracked session (`dir.untracked` — no reported cwd) still renders as a
// single chevron-less row in the folder slot, and it is now selectable like
// any other folder: its workspace holds that one session. See
// docs/WORKSPACE.md §6 for why it must stay reachable rather than merely
// visible, and for the sibling inference that gives most of these a real
// folder before they ever get here.
//
// What survives from the flat design, unchanged:
//   - attached sessions pin to the top of their root with a green dot and a
//     semibold label. The `attached` text tag stays retired: position, weight
//     and colour already say it.
//   - the timestamp is relative (`12m`), absolute in the tooltip.
//   - labels middle-truncate, so `git-pocketshell` and `git-pocketshell-quse`
//     stop rendering identically when the panel is narrow.
//   - the tooltip carries the full truth: session name, full path, absolute
//     time.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import NewSessionDialog from './NewSessionDialog.vue';
import { useConnectionStore } from '../stores/connection';
import { useProjectsStore } from '../stores/projects';
import { useSessionsStore } from '../stores/sessions';
import { useSettingsStore } from '../stores/settings';
import {
  groupSessionsIntoRoots,
  type SessionDirectory,
  type SessionRootFolder,
} from '../sessionGrouping';
import type { SessionAgentKind } from '../../shared/types';

const props = defineProps<{
  /**
   * Key of the folder whose workspace is open, so its row can be marked.
   *
   * A `SessionDirectory.key`, not a session name: selection is a FOLDER fact
   * now, and a workspace holding four session tabs still highlights exactly
   * one row.
   */
  activeFolder?: string | null;
}>();

/**
 * `back` and `collapse` are panel chrome, emitted for the host workspace to
 * act on. They live in THIS header because the host topbar is gone (the host's
 * identity moved to the OS title bar) and the `SESSIONS` row is now the
 * workspace's top-left row: an arrow beside `SESSIONS` reads as "leave this
 * host's sessions", and the hide toggle sits on the thing it hides. The
 * workspace stays the owner of the route and of the collapsed flag — this
 * component only announces the clicks.
 */
const emit = defineEmits<{
  /**
   * Open a folder's workspace. The optional second argument names a session
   * tab to select on arrival — used when a session was just created, where
   * "open the folder" alone would land on whichever tab sorts first rather
   * than on the one the user asked for.
   */
  select: [folder: SessionDirectory, session?: string];
  back: [];
  collapse: [];
}>();

const connection = useConnectionStore();
const projects = useProjectsStore();
const sessions = useSessionsStore();
const settings = useSettingsStore();
/** Whether the folder-first creation dialog is open. */
const creatingSession = ref(false);

/**
 * The host's `$HOME`, which is what turns `/home/alexey/git/dataops` into the
 * `git` root.
 *
 * Read from the projects store via `ensureHome`, which resolves the string
 * WITHOUT landing the folder browser on it — the SFTP listing `loadHome` also
 * does is of no use to this panel. It used to be fetched into a ref local to
 * this component, and that was a latent bug rather than an optimisation: the
 * folder workspace reads the same value out of the store, and `$HOME` is what
 * decides whether a folder is keyed `~/git/foo` or `/home/me/git/foo`. Two
 * spellings of one key is a panel row that opens a workspace with no tabs.
 *
 * If the fetch fails, grouping infers a home from the paths instead of dropping
 * every session into `other` (see `inferHome`).
 */
const home = computed(() => projects.home);

/**
 * Clock for the relative timestamps. The activity values only change when the
 * store refreshes, so this tick is cosmetic: it is what turns `59s` into `1m`
 * without a store round-trip.
 */
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;

/**
 * Nodes the user explicitly collapsed. Everything else is expanded.
 *
 * Only ROOT keys now: a folder is a leaf, so there is nothing under it to
 * disclose. The `dir:` namespacing this set used to need — a session sitting
 * directly in `~/git` produces a folder key byte-identical to its own root's —
 * went with the level it protected.
 */
const collapsed = ref<Set<string>>(new Set());

/**
 * The tree. The top level is the user's REGISTERED roots when they have any,
 * and `$HOME`'s children derived from the session paths when they do not —
 * the grouping module decides which, from whether the list is empty.
 */
const roots = computed(() =>
  groupSessionsIntoRoots(sessions.sessions, home.value, settings.sessionRoots),
);

onMounted(async () => {
  clock = setInterval(() => {
    now.value = Date.now();
  }, 60_000);
  if (!connection.connectionId) return;
  await sessions.refresh(connection.connectionId);
  // A failure is not worth surfacing: the panel still groups, just from the
  // shape of the paths. The dialog is where a missing `$HOME` is an error,
  // because there it blocks creating anything.
  await projects.ensureHome(connection.connectionId);
});

onBeforeUnmount(() => {
  if (clock !== null) clearInterval(clock);
});

function isExpanded(key: string): boolean {
  return !collapsed.value.has(key);
}

function toggle(key: string): void {
  // Reassigned, not mutated: a Set's contents are not deep-reactive here.
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
}

/**
 * Keep the open folder visible: navigating into one expands its root.
 *
 * One level to reopen now rather than two, which also retires `dirKey` — a
 * folder is a leaf here, so there is nothing under it to expand and nothing to
 * namespace its key against.
 *
 * This watches the ACTIVE FOLDER rather than the root list on purpose. Doing
 * it on every recompute would make a root impossible to collapse — the store
 * refreshes on a timer and would immediately reopen it — so a deliberate
 * collapse survives until the user navigates somewhere else.
 */
watch(
  () => props.activeFolder,
  (key) => {
    if (!key) return;
    const roots_ = roots.value.filter((root) => root.directories.some((d) => d.key === key));
    if (!roots_.some((root) => collapsed.value.has(root.key))) return;
    const next = new Set(collapsed.value);
    for (const root of roots_) next.delete(root.key);
    collapsed.value = next;
  },
  { immediate: true },
);

/** `1 session` / `3 sessions` — the phrase form, which lives only in tooltips. */
function sessionCountLabel(count: number): string {
  return count === 1 ? '1 session' : `${count} sessions`;
}

/**
 * Header tooltip: the root's real path plus its size. `~/git` rather than the
 * absolute form, because the key IS home-relative — the two spellings tmux
 * reports for one directory are deliberately folded into it.
 *
 * A registered root holding nothing says so in words. It is the one header
 * that can be empty, and "0" alone would read as a bug rather than as the
 * setting doing exactly what it was told.
 */
function rootTooltip(root: SessionRootFolder): string {
  const count = sessionCountLabel(root.sessionCount);
  if (root.other) return `sessions outside every root, or with no known folder\n${count}`;
  if (root.configured && root.sessionCount === 0) {
    return `${root.key}\nregistered in Settings — nothing running here`;
  }
  return `${root.key}\n${count}`;
}

/**
 * Folder tooltip: the full path, the session count, and the session NAMES.
 *
 * The names are here because they are no longer on screen — the workspace's
 * tab bar carries them, which is behind a click. One hover is the cheapest
 * place to answer "what is actually in here" without spending a row per
 * session again, and it is capped so a folder with a dozen sessions produces a
 * tooltip rather than a wall.
 *
 * An untracked folder says so instead of printing a path it does not have, and
 * one whose path was adopted from a sibling says THAT, because a guess
 * presented as a reported cwd is the kind of thing that wastes an hour
 * (docs/WORKSPACE.md §6.3).
 */
const TOOLTIP_NAME_LIMIT = 6;

function dirTooltip(dir: SessionDirectory): string {
  const lines: string[] = [];
  if (dir.untracked) {
    lines.push(
      dir.inferredRoot
        ? 'no reported folder — root read back from the name'
        : 'no reported folder',
    );
  } else {
    lines.push(dir.path);
    if (dir.rows.some((row) => row.session.pathInferred)) {
      lines.push('folder inferred from the session name, not reported by tmux');
    }
  }
  lines.push(sessionCountLabel(dir.rows.length));
  const names = dir.rows.slice(0, TOOLTIP_NAME_LIMIT).map((row) => `  ${row.session.name}`);
  lines.push(...names);
  if (dir.rows.length > TOOLTIP_NAME_LIMIT) {
    lines.push(`  … and ${dir.rows.length - TOOLTIP_NAME_LIMIT} more`);
  }
  return lines.join('\n');
}

async function onRefresh(): Promise<void> {
  if (connection.connectionId) await sessions.refresh(connection.connectionId);
}

/**
 * A folder-first session just came up on the host. Refresh so its folder
 * exists in the tree, then open that folder with the new session selected.
 *
 * The refresh is not optional and it is not merely a courtesy: the workspace
 * is addressed by FOLDER now, and the only thing the create returns is a
 * session name. The folder has to be looked up from a session list that
 * includes the new row.
 *
 * When the lookup misses — the listing has not caught up, or
 * `pocketshell sessions list` is broken on this host and we are on the raw-tmux
 * path — nothing is emitted and the panel simply shows what it has. That is a
 * deliberate downgrade from the old behaviour, which synthesised a summary and
 * routed to it: a session route only needed a name, and a folder route needs a
 * folder we do not have. Inventing one would put the user in a workspace for a
 * directory that does not exist.
 */
async function onSessionStarted(name: string): Promise<void> {
  creatingSession.value = false;
  if (connection.connectionId) await sessions.refresh(connection.connectionId);
  for (const root of roots.value) {
    const dir = root.directories.find((d) => d.rows.some((r) => r.session.name === name));
    if (dir) {
      emit('select', dir, name);
      return;
    }
  }
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

/**
 * The distinct agent kinds running in a folder, in row order, deduped.
 *
 * A folder row stands in for several sessions now, so a single badge would
 * have to pick one arbitrarily. Deduping and capping is the honest compromise:
 * a folder running claude and codex says both, a folder running three claudes
 * says `claude` once, and a folder running four different engines says the
 * first two and stops rather than pushing the timestamp off the row.
 */
const FOLDER_BADGE_LIMIT = 2;

function agentBadges(dir: SessionDirectory): string[] {
  const out: string[] = [];
  for (const row of dir.rows) {
    const badge = agentBadge(row.session.agentKind);
    if (badge !== null && !out.includes(badge)) out.push(badge);
    if (out.length === FOLDER_BADGE_LIMIT) break;
  }
  return out;
}

/**
 * Compact relative age: `now`, `12m`, `3h`, `2d`, then an absolute date past a
 * week. Six characters at the very worst, against ~90px for the absolute form
 * this replaced — and that width is exactly what the label needed back.
 *
 * There is no absolute-form companion any more. It existed for the session
 * row's tooltip, and the session rows are gone; a folder row's tooltip names
 * the folder and its sessions, which is what a folder is asked about.
 */
function fmtRelative(epochSeconds: number): string {
  if (!epochSeconds) return '';
  const seconds = Math.max(0, Math.floor(now.value / 1000) - epochSeconds);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}


</script>

<template>
  <div class="tree">
    <div class="tree-header">
      <button class="icon-btn" title="Back to hosts" @click="emit('back')">
        <AppIcon name="arrow-left" :size="14" />
      </button>
      <span class="title">sessions</span>
      <div class="header-actions">
        <button class="icon-btn" :disabled="sessions.loading" title="Refresh" @click="onRefresh">
          <AppIcon name="refresh" :size="14" :class="{ spin: sessions.loading }" />
        </button>
        <button class="icon-btn" title="Hide session panel" @click="emit('collapse')">
          <!-- VS Code's "toggle sidebar" mark: truer to the action than a
               hamburger, which promises a menu. -->
          <AppIcon name="panel-left" :size="14" />
        </button>
      </div>
    </div>

    <div class="folder-list">
      <section v-for="root in roots" :key="root.key" class="folder">
        <button
          class="folder-header"
          :aria-expanded="isExpanded(root.key)"
          :title="rootTooltip(root)"
          @click="toggle(root.key)"
        >
          <!-- The app's one disclosure pattern: the base
               mark is always `chevron-right` and open is a 90 degree rotation,
               so the two states are the same geometry. -->
          <AppIcon
            name="chevron-right"
            :size="14"
            class="disclosure"
            :class="{ open: isExpanded(root.key) }"
          />
          <!-- The dot is the collapsed root's only way to say "something live
               is in here", which is the state where that matters most. -->
          <span class="dot" :class="{ active: root.active }" />
          <span class="folder-label" :class="{ bucket: root.other }">{{ root.label }}</span>
          <span class="folder-count muted">{{ root.sessionCount }}</span>
        </button>

        <ul v-show="isExpanded(root.key)" class="dir-list">
          <!-- Only a REGISTERED root can be empty; a derived one exists because
               a session is in it. Saying so beats an expanded header with
               nothing under it, which reads as a failed load. -->
          <li v-if="!root.directories.length" class="empty-root muted">no sessions here yet</li>

          <!-- ONE ROW PER FOLDER. Not a header over a list any more: the row
               IS the destination, and what used to be its children are the
               tabs in the workspace it opens. Rendered as a <button> because
               it is a control that navigates, and marked `current` by the
               folder key so a workspace holding four session tabs still
               highlights exactly one row. -->
          <li v-for="dir in root.directories" :key="dir.key">
            <button
              class="dir-header"
              :class="{
                current: dir.key === props.activeFolder,
                orphan: dir.untracked,
                attached: dir.active,
              }"
              :title="dirTooltip(dir)"
              @click="emit('select', dir)"
            >
              <!-- The dot says "something live is in here". It used to be an
                   aggregate standing in for a collapsed branch; now it is the
                   only place the panel reports attachment at all, because the
                   sessions it belonged to are no longer rows. -->
              <span class="dot" :class="{ active: dir.active }" />
              <!-- Two spans, no measurement code: the head shrinks and
                   ellipsises, the tail is protected, so `pocketshell-desktop`
                   degrades to `poc…-desktop` rather than to `pocketshell`.
                   An untracked folder is labelled by its session name, which is
                   the only label it has. -->
              <span class="label" :class="{ mono: dir.untracked }">
                <span class="label-head">{{ dir.labelHead }}</span>
                <span v-if="dir.labelTail" class="label-tail">{{ dir.labelTail }}</span>
              </span>
              <span
                v-for="badge in agentBadges(dir)"
                :key="badge"
                class="agent-badge"
                :class="{ dim: badge === 'probing…' || badge === 'exited' }"
              >
                {{ badge }}
              </span>
              <!-- Counted only from 2 up. The `1` is the dead field §1 of
                   SESSIONLIST measured: every folder row stands for at least
                   one session, so saying so on most of them is noise. -->
              <span v-if="dir.rows.length > 1" class="folder-count muted">
                {{ dir.rows.length }}
              </span>
              <!-- The folder's age is its NEWEST session's, which is also the
                   key it sorts on — so a row never displays an older time than
                   a row sitting below it. -->
              <span class="row-time">{{ fmtRelative(dir.mostRecentActivity) }}</span>
            </button>
          </li>
        </ul>
      </section>

      <p v-if="!roots.length && !sessions.loading" class="empty muted">no sessions</p>
    </div>

    <!-- Folder-first, not name-first: this opens the picker rather than a text
         field, because the session name is DERIVED from the folder and typing
         one produced sessions that no other client could group. -->
    <div class="new-session">
      <button class="new-session-btn" title="New session" @click="creatingSession = true">
        <AppIcon name="plus" :size="14" />
        New session
      </button>
    </div>
    <p v-if="sessions.error" class="error">{{ sessions.error }}</p>

    <NewSessionDialog
      v-if="creatingSession"
      @started="onSessionStarted"
      @close="creatingSession = false"
    />
  </div>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  /* Flex-sized, not height:100%: the host panel is a flex column now, with
     the workspace's host-actions row below this component. The tree takes
     everything above it. Surface and the panel's right hairline moved to the
     aside for the same reason — a border on this element alone would stop
     short of that row. */
  flex: 1 1 auto;
  min-height: 0;
  /* Matches HostWorkspaceView's MIN_PANEL_WIDTH. It used to be 240px, which
     silently contradicted the 200px drag clamp. */
  min-width: 200px;
  /* Query container for the narrow-panel rule at the bottom of this block. */
  container-type: inline-size;
}
/* The workspace's top-left row, same --topbar-h as the session bar across the
   splitter, so the two headers read as one line. Padding is --sp-2, not
   --sp-3: ghost icon buttons carry their own inner inset, and the old padding
   plus theirs pushed the back arrow visibly off the panel's left rhythm. */
.tree-header {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  height: var(--topbar-h);
  flex: 0 0 auto;
  padding: 0 var(--sp-2);
  border-bottom: 1px solid var(--border);
}
.header-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  margin-left: auto;
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
  padding: 0 var(--row-pad-x) 0 var(--sp-2);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  font-weight: var(--fw-semibold);
  overflow: hidden;
}
.folder-header:hover {
  background: var(--state-hover);
}
/* Rotating the <svg> box pivots around its own centre — no transform-origin
   juggling and no baseline offset. */
.disclosure {
  color: var(--fg-muted);
  flex: none;
  transition: transform var(--dur-fast) var(--ease);
}
.disclosure.open {
  transform: rotate(90deg);
}
.folder-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* `other` is a bucket, not a directory: lowered so it does not read as a
   folder the user could navigate to. */
.folder-label.bucket {
  font-weight: var(--fw-regular);
  color: var(--fg-secondary);
}
/* Bare count, no `· 3 sessions`: the number is the whole message, and the
   header is the one row per root this design is allowed to spend. */
.folder-count {
  margin-left: auto;
  flex: none;
  font-weight: var(--fw-regular);
  font-size: var(--fs-100);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dir-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
/* ── The indent budget, in one place ───────────────────────────────────────
   TWO levels now, so the budget is halved and every row gets the width back
   that the third level was spending. The column both rows share is the DOT,
   because it is the one element every row type has; the labels follow it at a
   constant 16px (8px dot + an --sp-2 gap).

     level        chevron   dot    label
     root           8-22     30      46
     folder            -     38      54

   At the 200px panel floor the timestamp is already gone (see the container
   query at the bottom of this block) and a folder row has 200 - 54 - 10 =
   136px for its label, badges and count — against the 128px the old session
   leaf had, for a label that is a folder basename rather than a full session
   name. Middle truncation is kept anyway: `pocketshell` and
   `pocketshell-desktop` are still one root apart. */
/* Sits in the folder slot, but is prose rather than a row: no dot, so
   it starts where a directory LABEL starts (54) instead of where its dot
   does. */
.empty-root {
  height: var(--row-h);
  display: flex;
  align-items: center;
  padding: 0 var(--row-pad-x) 0 54px;
  font-size: var(--fs-200);
  font-style: italic;
}
/* One step in from the root header. There is no chevron column to allow for
   any more — a folder is a leaf — so the 36px inset puts the dot at 38, 8px
   right of the root's, which is the whole of the nesting this panel now
   expresses. */
.dir-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  height: var(--row-h);
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  color: var(--fg);
  text-align: left;
  padding: 0 var(--row-pad-x) 0 36px;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  overflow: hidden;
}
.dir-header:hover {
  background: var(--state-hover);
}
/* Selection is accent-tinted and railed; hover is a neutral lift. The two used
   to be the same cyan at two alphas, which read as one state. */
.dir-header.current {
  background: var(--state-selected);
  border-left-color: var(--accent);
}
/* A folder that is only a session — no reported cwd — is labelled by that
   session's NAME, so it is set in the mono face the name deserves and toned
   down, because it is a row we could not place rather than a folder the user
   organised. */
.dir-header.orphan .label {
  color: var(--fg-secondary);
}
/* Trims the shared 8px flex gap to the 4px the alignment above needs, without
   giving this row its own gap value to keep in sync with everything else. */
.dir-header .disclosure {
  margin-right: -4px;
}
.dir-header:hover {
  background: var(--state-hover);
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
/* The label wins the width fight; everything else shrinks first. */
.label {
  display: flex;
  align-items: baseline;
  flex: 1 1 auto;
  min-width: 0;
  color: var(--fg);
}
.label.mono {
  font-family: var(--font-mono);
}
/* A folder holding an attached session is semibold, so weight, colour (the
   green dot) and sort position all say the same thing. This is what replaced
   the `attached` tag. */
.dir-header.attached .label {
  font-weight: var(--fw-semibold);
}
.label-head {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Protected: the distinguishing text of a project name is its tail. */
.label-tail {
  flex: none;
  white-space: nowrap;
}
/* Badge metric, shared by every --r-sm chip in the app (docs/POLISH.md §7):
   inline-flex, 0 var(--sp-1) padding, --lh-100. */
.agent-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex: none;
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
.row-time {
  flex: none;
  font-size: var(--fs-100);
  color: var(--fg-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
.new-session {
  display: flex;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border-top: 1px solid var(--border);
}
/* Full-width because it is the panel's one primary action, and bordered
   because a ghost control at the foot of a scrolling list reads as debris.
   WCAG 1.4.11: --border-strong is the 4.12:1 control boundary. */
.new-session-btn {
  flex: 1;
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
.new-session-btn:hover {
  color: var(--accent);
  border-color: var(--accent-dim);
  background: var(--accent-soft);
}
.error {
  padding: 0 var(--sp-3) var(--sp-2);
}

/* Below ~270px the row cannot hold every field. The timestamp goes first: it
   is the least operational of them, and a recency-sorted list already carries
   most of what it says. Dot, label and badge survive to the 200px floor. The
   rule is unscoped on purpose, so a directory header drops its aggregate age
   at the same width its children drop theirs — a header still showing a time
   above rows that had theirs removed would read as its own, separate fact.
   270 rather than revision 2's 250, by the same arithmetic that set 250: the
   leaf row is 16px deeper than the single-session row it replaces, and it now
   carries a full session name rather than a short directory basename, so it
   runs out of width that much sooner. */
@container (width < 270px) {
  .row-time {
    display: none;
  }
}
</style>
