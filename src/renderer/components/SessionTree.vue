<script setup lang="ts">
// SessionTree: the live tmux session list for the active connection.
//
// FLAT — one row per session (docs/SESSIONLIST.md). It used to be a two-level
// folder tree ported from the Android host-detail screen, which assumed
// folders with real fan-out. On a real host the distribution is 1:1 (11
// folders, 11 sessions), so every folder header cost a row to say nothing;
// worse, the session name is DERIVED from the folder path
// (`~/git/dataops` -> `git-dataops`), so the two lines were the same fact
// twice and both truncated to `git-…`. The phone escapes this because its top
// level is watched project ROOTS, not individual folders.
//
// So: the folder supplies the row's label, and the session name appears only
// when it is NOT derivable from that label — the worktree case (folder
// `merry-sniffing-tortoise` holding session `git-dtc-website`), a custom name,
// or a folder with siblings that a shared label cannot separate. The grouping
// module is unchanged and still authoritative; see `flattenSessions`.
//
// Three other things the flat row does that the tree could not:
//   - attached sessions pin to the TOP with a green dot and a semibold label,
//     which is the real answer to "the session I was just in". The `attached`
//     text tag is retired: position, weight and colour already say it.
//   - the timestamp is relative (`12m`), absolute in the tooltip. The old
//     `Aug 24, 01:10 PM` spent ~90px per row restating the sort order.
//   - the label middle-truncates, so `pocketshell` and `pocketshell-desktop`
//     stop rendering identically when the panel is narrow.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import NewSessionDialog from './NewSessionDialog.vue';
import { useConnectionStore } from '../stores/connection';
import { useSessionsStore } from '../stores/sessions';
import { flattenSessions, type SessionRow } from '../sessionGrouping';
import type { SessionAgentKind, SessionSummary } from '../../shared/types';

const props = defineProps<{
  /** Name of the session currently open, so its row can be marked. */
  activeSession?: string | null;
}>();

const emit = defineEmits<{ select: [session: SessionSummary] }>();

const connection = useConnectionStore();
const sessions = useSessionsStore();
/** Whether the folder-first creation dialog is open. */
const creatingSession = ref(false);

/**
 * Clock for the relative timestamps. The activity values only change when the
 * store refreshes, so this tick is cosmetic: it is what turns `59s` into `1m`
 * without a store round-trip.
 */
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;

const rows = computed(() => flattenSessions(sessions.sessions));

onMounted(async () => {
  clock = setInterval(() => {
    now.value = Date.now();
  }, 60_000);
  if (connection.connectionId) {
    await sessions.refresh(connection.connectionId);
  }
});

onBeforeUnmount(() => {
  if (clock !== null) clearInterval(clock);
});

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
 * session name, folder path, absolute time. An untracked session has no path
 * line because it genuinely has no path.
 */
function tooltip(row: SessionRow): string {
  const when = fmtAbsolute(row.session.activity || row.session.created);
  const lines = [row.session.name];
  if (!row.untracked) lines.push(row.folderPath);
  if (when) lines.push(when);
  return lines.join('\n');
}
</script>

<template>
  <div class="tree">
    <div class="tree-header">
      <span class="title">sessions</span>
      <button class="icon-btn" :disabled="sessions.loading" title="Refresh" @click="onRefresh">
        <AppIcon name="refresh" :size="14" :class="{ spin: sessions.loading }" />
      </button>
    </div>

    <ul class="session-list">
      <li
        v-for="row in rows"
        :key="row.session.name"
        class="session-row"
        :class="{ current: row.session.name === props.activeSession, attached: row.session.attached }"
        :title="tooltip(row)"
        @click="emit('select', row.session)"
      >
        <span class="dot" :class="{ active: row.session.attached }" />
        <!-- Two spans, no measurement code: the head shrinks and ellipsises,
             the tail is protected, so `pocketshell-desktop` degrades to
             `poc…-desktop` rather than to `pocketshell`. -->
        <span class="label" :class="{ mono: row.untracked }">
          <span class="label-head">{{ row.labelHead }}</span>
          <span v-if="row.labelTail" class="label-tail">{{ row.labelTail }}</span>
        </span>
        <span v-if="row.showName" class="row-name">{{ row.session.name }}</span>
        <span
          v-if="agentBadge(row.session.agentKind)"
          class="agent-badge"
          :class="{ dim: row.session.agentKind === 'probing' || row.session.agentKind === 'exited' }"
        >
          {{ agentBadge(row.session.agentKind) }}
        </span>
        <span class="row-time">{{ fmtRelative(row.session.activity || row.session.created) }}</span>
      </li>

      <li v-if="!rows.length && !sessions.loading" class="empty muted">no sessions</li>
    </ul>

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
  height: 100%;
  /* Matches HostWorkspaceView's MIN_PANEL_WIDTH. It used to be 240px, which
     silently contradicted the 200px drag clamp. */
  min-width: 200px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  /* Query container for the narrow-panel rule at the bottom of this block. */
  container-type: inline-size;
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
.session-list {
  list-style: none;
  margin: 0;
  padding: var(--sp-2) 0;
  flex: 1;
  overflow-y: auto;
}
.session-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--row-h);
  /* 2px of the left inset is the selection rail's slot, so a row does not
     shift horizontally when it becomes current. There is no parent row to
     align under any more, so the old 28px child indent is gone with it. */
  padding: 0 var(--row-pad-x) 0 var(--sp-2);
  border-left: 2px solid transparent;
  cursor: pointer;
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  overflow: hidden;
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
/* Only rendered when the name is NOT derivable from the label — otherwise it
   is the same word twice, which is what the old tree did on every row. */
.row-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--fs-100);
  color: var(--fg-secondary);
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

/* Below ~230px the row cannot hold every field. The timestamp goes first: it
   is the least operational of them, and a recency-sorted list already carries
   most of what it says. Dot, label and badge survive to the 200px floor. */
@container (width < 230px) {
  .row-time {
    display: none;
  }
}
</style>
