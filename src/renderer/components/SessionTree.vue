<script setup lang="ts">
// SessionTree: the live tmux session list for the active connection, as a
// FOLDER VIEW (docs/SESSIONLIST.md) — the shape the phone app has and the one
// the user asked for, three times, in these words: `git -> folder -> session`.
//
// THREE levels, always, with no conditional collapsing anywhere:
//
//   v git                        12
//     v dtc-website
//         git-dtc-website               21h
//     v pocketshell                2
//         git-pocketshell               21h
//         git-pocketshell-quse          20h
//     v dataops
//         git-dataops                   22h
//   > other                         3
//
// Revisions 1 and 2 of the spec both argued for making the directory level
// CONDITIONAL — a directory holding one session collapsed into a single row,
// on the strength of §1's measurement that a folder header at 1:1 costs a row
// to say nothing. The measurement was real and the conclusion was wrong, for a
// reason no row count can express: on this user's host almost every directory
// holds exactly one session, so the conditional fired on nearly every node and
// the panel rendered as one `git` header over a flat list of twelve rows. A
// tree whose nodes collapse whenever they hold one child does not read as a
// tree. The structure the user wants to SEE is the deliverable here, not the
// row count — so the directory row is always a header with its sessions
// nested beneath it, and it is no longer selectable: clicking it expands.
//
// The one node type that still renders as a single row is a session with no
// reported working directory at all (`dir.untracked`). That is not the old
// conditional coming back through the side door: it is not "this directory
// holds one session", it is "there is no directory". Its only available label
// IS its session name, so a header would print that name twice on adjacent
// rows — the doubled row the user circled in the first place. It sits in the
// directory slot, chevron-less, as a direct child of its root (§4.6).
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
import { api } from '../ipc';
import { useConnectionStore } from '../stores/connection';
import { useProjectsStore } from '../stores/projects';
import { useSessionsStore } from '../stores/sessions';
import { useSettingsStore } from '../stores/settings';
import {
  groupSessionsIntoRoots,
  type SessionDirectory,
  type SessionRootFolder,
  type SessionRow,
} from '../sessionGrouping';
import type { SessionAgentKind, SessionSummary } from '../../shared/types';

const props = defineProps<{
  /** Name of the session currently open, so its row can be marked. */
  activeSession?: string | null;
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
const emit = defineEmits<{ select: [session: SessionSummary]; back: []; collapse: [] }>();

const connection = useConnectionStore();
const projects = useProjectsStore();
const sessions = useSessionsStore();
const settings = useSettingsStore();
/** Whether the folder-first creation dialog is open. */
const creatingSession = ref(false);

/**
 * The host's `$HOME`, which is what turns `/home/alexey/git/dataops` into the
 * `git` root. Fetched here rather than through `projects.loadHome` because
 * that action also lands the folder BROWSER on `$HOME` — an SFTP directory
 * listing this panel has no use for. If the dialog already resolved it, reuse
 * that; if the fetch fails, grouping infers a home from the paths instead of
 * dropping every session into `other` (see `inferHome`).
 */
const home = ref<string | null>(null);

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
 * Holds both levels. Directory keys are namespaced with `dir:` because a
 * session sitting directly in `~/git` produces a DIRECTORY key of `~/git`,
 * which is byte-identical to its own root's key — without the prefix,
 * collapsing one would silently collapse the other.
 */
const collapsed = ref<Set<string>>(new Set());

/** Expansion key for a directory branch. See {@link collapsed}. */
function dirKey(dir: SessionDirectory): string {
  return `dir:${dir.key}`;
}

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
  home.value = projects.home;
  await sessions.refresh(connection.connectionId);
  if (home.value === null) {
    const result = await api.projects.home(connection.connectionId);
    // A failure is not worth surfacing: the panel still groups, just from the
    // shape of the paths. The dialog is where a missing `$HOME` is an error,
    // because there it blocks creating anything.
    if (result.ok && result.home) home.value = result.home;
  }
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
 * Keep the open session visible: navigating into a session expands every
 * ancestor holding it — its root AND its directory, which since revision 3 is
 * always a real branch rather than sometimes being the session's own row.
 *
 * This watches the ACTIVE SESSION rather than the root list on purpose, at
 * BOTH levels. Doing it on every recompute would make the containing node
 * impossible to collapse — the store refreshes on a timer and would
 * immediately reopen it — so a deliberate collapse survives until the user
 * navigates somewhere else. The directory level walks into the same trap if it
 * is wired to the list, which is why it is wired here instead.
 */
watch(
  () => props.activeSession,
  (name) => {
    if (!name) return;
    const reopen: string[] = [];
    for (const root of roots.value) {
      for (const dir of root.directories) {
        if (!dir.rows.some((row) => row.session.name === name)) continue;
        reopen.push(root.key, dirKey(dir));
      }
    }
    if (!reopen.some((key) => collapsed.value.has(key))) return;
    const next = new Set(collapsed.value);
    for (const key of reopen) next.delete(key);
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
 * Branch tooltip: the directory's full path and how many sessions are in it.
 * The row itself only ever shows the leaf component, which is the point.
 */
function dirTooltip(dir: SessionDirectory): string {
  return `${dir.path}\n${sessionCountLabel(dir.rows.length)}`;
}

async function onRefresh(): Promise<void> {
  if (connection.connectionId) await sessions.refresh(connection.connectionId);
}

/**
 * A folder-first session just came up on the host. Refresh so the row exists,
 * then open it.
 *
 * The fallback synthesises a summary from the name the host returned: on a
 * host where `pocketshell sessions list` is broken the app is already on the
 * raw-tmux path, and a listing that has not caught up yet must not swallow a
 * session the host has confirmed. The route only keys on the name.
 */
async function onSessionStarted(name: string): Promise<void> {
  creatingSession.value = false;
  if (connection.connectionId) await sessions.refresh(connection.connectionId);
  const row = sessions.sessions.find((s) => s.name === name);
  emit(
    'select',
    row ?? { name, created: 0, activity: 0, attached: false, path: null, agentKind: null },
  );
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
 * Compact relative age: `now`, `12m`, `3h`, `2d`, then an absolute date past a
 * week. Six characters at the very worst, against ~90px for the absolute form
 * this replaced — and that width is exactly what the label needed back.
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

function fmtAbsolute(epochSeconds: number): string {
  if (!epochSeconds) return '';
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The row's full truth, since the row itself shows an abbreviation of it:
 * session name, folder path, absolute time.
 *
 * The leaf row is labelled by the session NAME at every depth now, so this is
 * no longer the only place a name is written — but it is still the only place
 * the name appears UNTRUNCATED, next to the directory that a leaf row does not
 * repeat because its parent header already said it.
 *
 * An untracked session has no path line because it genuinely has no path; if
 * its root was recovered from its name instead, the tooltip says so, because a
 * guess presented as a reported cwd is the kind of thing that wastes an hour.
 */
function tooltip(row: SessionRow, dir: SessionDirectory): string {
  const when = fmtAbsolute(row.session.activity || row.session.created);
  const lines = [row.session.name];
  if (!dir.untracked) lines.push(dir.path);
  else if (dir.inferredRoot) lines.push('no reported folder — root read back from the name');
  if (when) lines.push(when);
  return lines.join('\n');
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
          <!-- One disclosure pattern, shared with ConversationView: the base
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
          <template v-for="dir in root.directories" :key="dir.key">
            <!-- No reported cwd, so there is no directory to put a level at.
                 Its session name is its only label, and a header above a child
                 saying the same string is the doubled row this panel exists to
                 get rid of. Rendered in the DIRECTORY slot, chevron-less, so
                 its dot still lands in the directory dot column. -->
            <li
              v-if="dir.untracked"
              class="session-row orphan"
              :class="{
                current: dir.rows[0]!.session.name === props.activeSession,
                attached: dir.rows[0]!.session.attached,
              }"
              :title="tooltip(dir.rows[0]!, dir)"
              @click="emit('select', dir.rows[0]!.session)"
            >
              <span class="dot" :class="{ active: dir.rows[0]!.session.attached }" />
              <span class="label mono">
                <span class="label-head">{{ dir.rows[0]!.nameHead }}</span>
                <span v-if="dir.rows[0]!.nameTail" class="label-tail">
                  {{ dir.rows[0]!.nameTail }}
                </span>
              </span>
              <span
                v-if="agentBadge(dir.rows[0]!.session.agentKind)"
                class="agent-badge"
                :class="{
                  dim:
                    dir.rows[0]!.session.agentKind === 'probing' ||
                    dir.rows[0]!.session.agentKind === 'exited',
                }"
              >
                {{ agentBadge(dir.rows[0]!.session.agentKind) }}
              </span>
              <span class="row-time">
                {{ fmtRelative(dir.rows[0]!.session.activity || dir.rows[0]!.session.created) }}
              </span>
            </li>

            <!-- Every real directory, whatever it holds: a header plus its
                 sessions. A <button>, which is also the answer to "what does
                 clicking a directory do" — it toggles, and it can no longer
                 select a session, because the session it used to stand in for
                 now has a row of its own directly underneath. -->
            <li v-else class="dir-branch">
              <button
                class="dir-header"
                :aria-expanded="isExpanded(dirKey(dir))"
                :title="dirTooltip(dir)"
                @click="toggle(dirKey(dir))"
              >
                <AppIcon
                  name="chevron-right"
                  :size="14"
                  class="disclosure"
                  :class="{ open: isExpanded(dirKey(dir)) }"
                />
                <!-- Aggregate dot, same rule the root header uses: a collapsed
                     branch's only way to say something live is inside it. -->
                <span class="dot" :class="{ active: dir.active }" />
                <!-- Two spans, no measurement code: the head shrinks and
                     ellipsises, the tail is protected, so `pocketshell-desktop`
                     degrades to `poc…-desktop` rather than to `pocketshell`. -->
                <span class="label">
                  <span class="label-head">{{ dir.labelHead }}</span>
                  <span v-if="dir.labelTail" class="label-tail">{{ dir.labelTail }}</span>
                </span>
                <!-- Counted only from 2 up. This is the one thing §1's
                     measurement is still right about: a `1` beside a header
                     whose single child is drawn on the very next row is the
                     dead field, and dropping it also hands the label back the
                     width the new indent level took. -->
                <span v-if="dir.rows.length > 1" class="folder-count muted">
                  {{ dir.rows.length }}
                </span>
                <!-- The branch's age is its NEWEST session's, which is also the
                     key it sorts on — so a branch never displays an older time
                     than a branch sitting below it. -->
                <span class="row-time">{{ fmtRelative(dir.mostRecentActivity) }}</span>
              </button>

              <ul v-show="isExpanded(dirKey(dir))" class="session-list">
                <li
                  v-for="row in dir.rows"
                  :key="row.session.name"
                  class="session-row child"
                  :class="{
                    current: row.session.name === props.activeSession,
                    attached: row.session.attached,
                  }"
                  :title="tooltip(row, dir)"
                  @click="emit('select', row.session)"
                >
                  <span class="dot" :class="{ active: row.session.attached }" />
                  <!-- Middle-truncated too, and here it matters most: siblings
                       share a derived prefix by construction. -->
                  <span class="label mono">
                    <span class="label-head">{{ row.nameHead }}</span>
                    <span v-if="row.nameTail" class="label-tail">{{ row.nameTail }}</span>
                  </span>
                  <span
                    v-if="agentBadge(row.session.agentKind)"
                    class="agent-badge"
                    :class="{
                      dim:
                        row.session.agentKind === 'probing' || row.session.agentKind === 'exited',
                    }"
                  >
                    {{ agentBadge(row.session.agentKind) }}
                  </span>
                  <span class="row-time">
                    {{ fmtRelative(row.session.activity || row.session.created) }}
                  </span>
                </li>
              </ul>
            </li>
          </template>
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
.dir-list,
.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
/* ── The indent budget, in one place ───────────────────────────────────────
   Three levels have to fit above the 200px panel floor, so the step is the
   smallest one that still reads as nesting: 8px, VS Code's own tree step. The
   column all three rows share is the DOT, because it is the one element every
   row type has; the labels then follow it at a constant 16px (8px dot + an
   --sp-2 gap) and inherit the same rhythm.

     level        chevron   dot    label
     root           8-22     30      46
     directory     20-34     38      54
     session          -      46      62

   So the leaf label starts 16px further in than the row it replaces (the old
   single-session row put it at 46), which is the whole cost of the level. At
   the 200px floor the timestamp is already gone (see the container query at
   the bottom of this block) and the leaf has 200 - 62 - 10 = 128px for label
   and badge; middle truncation is what makes that survivable, because it is
   the tail of `git-pocketshell-quse` that separates it from its sibling. At
   the 280px default the leaf gets 208px, which clears the longest name in the
   real data set untruncated. */
.session-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--row-h);
  /* 2px of the left inset is the selection rail's slot, so a row does not
     shift horizontally when it becomes current. 2 + 44 puts the leaf dot at
     46, one 8px step in from its directory header's. */
  padding: 0 var(--row-pad-x) 0 44px;
  border-left: 2px solid transparent;
  cursor: pointer;
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  overflow: hidden;
}
/* A session with no directory stands IN the directory slot rather than under
   one, so it takes the directory dot column (2 + 36 = 38) and simply leaves
   the chevron column empty, the way any tree draws a childless node. */
.session-row.orphan {
  padding-left: 36px;
}
/* Sits in the directory slot too, but is prose rather than a row: no dot, so
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
.session-row:hover {
  background: var(--state-hover);
}
/* Selection is accent-tinted and railed; hover is a neutral lift. The two
   used to be the same cyan at two alphas, which read as one state. */
.session-row.current {
  background: var(--state-selected);
  border-left-color: var(--accent);
}
.dir-branch {
  display: block;
}
/* One step in from the root header: 2px rail slot + 18px puts the 14px chevron
   box at 20-34, and a 4px gap lands the dot at 38 — 8px right of the root's.
   Revision 2 deliberately kept this dot at 30, in the root's own column,
   because directory HEADERS and single-session directory ROWS alternated down
   the list and a stepped dot would have read as jitter. There is no such
   alternation any more: every directory is a header, so the column can say
   what it should have said all along, which is "you are one level deeper". */
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
  padding: 0 var(--row-pad-x) 0 18px;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  overflow: hidden;
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
/* Attached rows are semibold, so weight, colour (the green dot) and sort
   position all say the same thing. This is what replaced the `attached` tag. */
.session-row.attached .label {
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
