<script setup lang="ts">
// SessionTree: the live tmux session list for the active connection, as a
// FOLDER VIEW — TWO levels, root then folder, one row per folder
// (docs/WORKSPACE.md §2, revising docs/SESSIONLIST.md revision 3):
//
//   git                          12
//     dtc-website           2       21h
//     pocketshell           3       21h
//     dataops                       22h
//   other                           3
//
// The root line carries no disclosure mark because it is not a node: it is a
// grouping HEADER over the folder rows beneath it, and there is nothing under
// it that hiding would spare the reader. See the root row in the template for
// why that is deliberate and what a future collapse must not do.
//
// It does carry a `+`, revealed on hover or focus, which creates a session
// under that root — and that is not a contradiction of the paragraph above. A
// chevron would promise a STATE the row does not have; a `+` promises an
// action, which it does. The panel's foot button went when this arrived; see
// the end of the template.
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
// single row in the folder slot, and it is now selectable like
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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import NewSessionDialog from './NewSessionDialog.vue';
import HostActionsMenu from './HostActionsMenu.vue';
import { type HostPanel } from '../hostPanels';
import { type Box } from '../../shared/popupPlacement';
import { useConnectionStore } from '../stores/connection';
import { useProjectsStore } from '../stores/projects';
import { useSessionsStore } from '../stores/sessions';
import { useSettingsStore } from '../stores/settings';
import {
  groupSessionsIntoRoots,
  inferHome,
  rootHostPath,
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
  /** Open a host-scoped overlay. The workspace owns the overlays; this row
   *  only announces which one was asked for. */
  panel: [name: HostPanel];
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

/**
 * The folder-first creation dialog: null when shut, otherwise the directory it
 * opens the browser AT.
 *
 * One piece of state for TWO controls, because they are one flow entered at two
 * depths. The header's `+` is "a session anywhere" and starts at `$HOME`
 * (`startIn: null`); a root row's `+` is "a session under `git`" and starts
 * there. Neither guesses a folder — the root is known and the folder is not, so
 * the picker still opens; it just opens one level in.
 *
 * A boolean plus a separate path ref would let the two disagree — dialog open,
 * path stale from the last root — which is precisely the class of bug that puts
 * a session in the wrong directory. Held as one object, they cannot.
 */
const creating = ref<{ startIn: string | null } | null>(null);

/**
 * The host-actions overflow menu — Ports and Usage (docs/DESIGN.md §5.3c,
 * revised by §5.3d).
 *
 * The user circled the panel's foot row and drew an arrow to this header:
 * "we can move this things there". Moving them is easy; fitting them is not.
 * The header already holds Back, a label, Refresh and the collapse toggle, and
 * the panel drags down to a 200px floor — seven controls in one strip at that
 * width is not a strip, it is a scramble.
 *
 * So they move as ONE control, and this is what makes the move affordable
 * rather than merely possible. It also settles the objection ca79ae2 raised
 * against putting them here in the first place: "two unlabelled overlay glyphs
 * would be a memory test". Inside a menu they keep their WORDS — `Port
 * forwarding`, `Provider usage` — so nothing is reduced to a glyph, and the
 * strip spends one 14px mark instead of ~150px of buttons.
 *
 * The `SESSIONS` label goes with them, and it is the cheapest thing in the row:
 * it labels a panel whose contents are self-evidently folders, on a window
 * whose title already carries the host. Its width pays for the new control
 * outright.
 *
 * SETTINGS is no longer one of the items. The user asked for the gear back as
 * its own control ("… then refresh then settings then hide"), and that does not
 * reopen the argument above — the objection was about glyphs nobody can read,
 * and the gear is the one mark of the three that is already icon-only across
 * this whole app. The two that need words still have them, here.
 */
const hostMenuAnchor = ref<Box | null>(null);
const hostMenuButton = ref<HTMLElement | null>(null);

function toggleHostMenu(): void {
  if (hostMenuAnchor.value) {
    hostMenuAnchor.value = null;
    return;
  }
  const box = hostMenuButton.value?.getBoundingClientRect();
  if (box) {
    hostMenuAnchor.value = { left: box.left, top: box.top, width: box.width, height: box.height };
  }
}

function openPanel(name: HostPanel): void {
  hostMenuAnchor.value = null;
  emit('panel', name);
}

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
 *
 * The inference is applied HERE rather than left to `groupSessionsIntoRoots`,
 * which used to do it privately, because a second consumer arrived that needs
 * the same answer: `rootHostPath`, which turns a root's `~/git` key back into
 * an absolute directory for the root row's `+`. Two callers deriving `$HOME`
 * separately is how the panel and the workspace once ended up keying one folder
 * two ways. `groupSessionsIntoRoots` still infers when handed null, so this is
 * a widening of where the answer is visible, not a change to it — passing an
 * already-inferred home through it is idempotent.
 */
const home = computed(
  () => projects.home ?? inferHome(sessions.sessions.map((s) => s.path)),
);

/**
 * Clock for the relative timestamps. The activity values only change when the
 * store refreshes, so this tick is cosmetic: it is what turns `59s` into `1m`
 * without a store round-trip.
 */
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;

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
 * The absolute host directory a root's `+` would start the picker in, or null
 * when the root names no directory we can resolve.
 *
 * Null has two causes and they are not the same. `other` is a BUCKET — the
 * sessions that matched no root — so there is no place to create anything in;
 * the template does not render a `+` on it at all. The second is a `~`-keyed
 * root on a host whose `$HOME` never resolved and could not be inferred from
 * the paths either, and there the `+` renders DISABLED rather than vanishing:
 * the control is real, the host is temporarily unable to answer, and a button
 * that disappears on a failed fetch reads as a feature that is not there.
 */
function rootAddPath(root: SessionRootFolder): string | null {
  return rootHostPath(root.key, home.value);
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
  creating.value = null;
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
    <!-- The `SESSIONS` word is gone, and its width is what pays for the host
         actions arriving here. See `hostMenuAnchor` in the script. -->
    <div class="tree-header">
      <button class="icon-btn" title="Back to hosts" @click="emit('back')">
        <AppIcon name="arrow-left" :size="14" />
      </button>
      <!-- ORDER: `+`, then overflow, refresh, settings, hide.
           The last four are the user's, given as "here have ... then refresh
           then settings then hide" against a screenshot of this strip. The `+`
           leads because it is the panel's primary action and the other four are
           chrome; their relative order is exactly as asked.

           WIDTH, at the 200px drag floor, because this strip is now full:
           six --control-h squares (6×28 = 168) plus five --sp-1 gaps (20) is
           188px, in a content box of 200 − 8 − 4 = 188. It fits EXACTLY, with
           no shrink and nothing clipped, and that is why the right padding is
           --sp-1 against the left's --sp-2 (see .tree-header). There is no room
           for a seventh: the next control added here has to displace one, the
           way the `SESSIONS` word paid for the overflow mark in §5.3c. -->
      <div class="header-actions">
        <!-- The general `+`: a session in ANY folder, nothing pre-filled. It is
             what replaced the panel's full-width foot button, and it is the
             reason that removal is safe — this control is on screen whatever
             the panel holds, including when it holds nothing at all, so there
             is never a window with no way to create a session. -->
        <button
          class="icon-btn"
          title="New session in any folder"
          @click="creating = { startIn: null }"
        >
          <AppIcon name="plus" :size="14" />
        </button>
        <!-- Two items now, not three: the gear left this menu for the slot two
             along. Ports and Usage stay, because they are the two that need
             their WORDS (docs/DESIGN.md §5.3c). -->
        <button
          ref="hostMenuButton"
          class="icon-btn"
          :class="{ on: hostMenuAnchor !== null }"
          title="Ports, Usage"
          aria-haspopup="menu"
          :aria-expanded="hostMenuAnchor !== null"
          @click="toggleHostMenu"
        >
          <AppIcon name="more-horizontal" :size="14" />
        </button>
        <button class="icon-btn" :disabled="sessions.loading" title="Refresh" @click="onRefresh">
          <AppIcon name="refresh" :size="14" :class="{ spin: sessions.loading }" />
        </button>
        <!-- The gear, back out of the overflow menu at the user's request. It
             is the one of the three that can be icon-only without becoming a
             memory test: this exact mark opens settings on the host picker and
             everywhere else in the app, so it is recognised rather than
             remembered. -->
        <button class="icon-btn" title="Settings" @click="openPanel('settings')">
          <AppIcon name="settings" :size="14" />
        </button>
        <button class="icon-btn" title="Hide session panel" @click="emit('collapse')">
          <!-- VS Code's "toggle sidebar" mark: truer to the action than a
               hamburger, which promises a menu. -->
          <AppIcon name="panel-left" :size="14" />
        </button>
      </div>

      <HostActionsMenu
        v-if="hostMenuAnchor"
        :anchor="hostMenuAnchor"
        :trigger="hostMenuButton"
        @select="openPanel"
        @close="hostMenuAnchor = null"
      />
    </div>

    <div class="folder-list">
      <section v-for="root in roots" :key="root.key" class="folder">
        <!-- A plain element, not a <button>, and no disclosure mark: now that
             sessions live in workspace tabs the panel is root -> folder, and a
             root row is a grouping HEADER over its folders rather than a node
             with something hidden under it. A chevron here would advertise an
             interaction that does not exist, so the row is not interactive at
             all — the tooltip is the only thing it still offers, and it carries
             real information (the root's path and its size).

             ROOT ROWS ARE DELIBERATELY ALWAYS OPEN. If collapsing ever comes
             back, it must NOT be driven off the root list: `roots` recomputes
             every time the sessions store refreshes on its timer, so anything
             that reopens roots on recompute would reopen one the instant the
             user closed it. The state removed here dodged that by watching the
             ACTIVE FOLDER instead, so a deliberate collapse survived until the
             user navigated somewhere else. That is the trap, written down. -->
        <div class="folder-header" :title="rootTooltip(root)">
          <!-- The dot is how a root reports attachment in ONE mark: a reader
               scanning the headers sees which roots have something live in them
               without reading the folder rows underneath, and on a registered
               root with nothing running it is the difference between "quiet"
               and "not loaded". -->
          <span class="dot" :class="{ active: root.active }" />
          <span class="folder-label" :class="{ bucket: root.other }">{{ root.label }}</span>
          <span class="folder-count muted">{{ root.sessionCount }}</span>
          <!-- Per-root `+`: create a session UNDER THIS ROOT. It opens the same
               folder picker the header's `+` does, one level in — the root is
               known, the folder is not, and guessing a directory from a root is
               how you get a session in the wrong place.

               NOT on `other`. That row is a bucket for paths that matched no
               root, not a directory, so there is nowhere for the picker to
               start; the header's `+` already covers "somewhere else".

               `@click.stop` even though the row takes no click today. The row
               is deliberately inert (see the comment above), but "deliberately"
               is a decision that can be revisited, and a `+` that also selects
               the row it sits on is a bug that would arrive silently the moment
               it were. One modifier now, or a mystery later.

               `:title` carries the destination, because the mark alone cannot
               say WHICH root it belongs to once the eye is on the right of the
               row rather than the left. -->
          <button
            v-if="!root.other"
            class="icon-btn sm root-add"
            :disabled="rootAddPath(root) === null"
            :title="
              rootAddPath(root) === null
                ? `cannot resolve $HOME on this host, so ${root.label} has no directory to start in`
                : `New session in ${root.key}`
            "
            @click.stop="creating = { startIn: rootAddPath(root) }"
          >
            <AppIcon name="plus" :size="12" />
          </button>
        </div>

        <ul class="dir-list">
          <!-- Only a REGISTERED root can be empty; a derived one exists because
               a session is in it. Saying so beats a header with nothing under
               it, which reads as a failed load — and there is no collapsed
               state left to blame it on. -->
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

    <!-- The full-width `New session` button that used to sit here is GONE. It
         was the panel's one primary action and it spent a bordered 44px foot
         row saying so, permanently, for a flow that now has two better doors:
         the `+` in the header (any folder) and the `+` on each root (this
         root). Both are always on screen, so nothing was traded away — and the
         foot row's real cost was that it answered "where?" with a browse
         starting at `$HOME` even when the user had just pointed at `git`.

         Folder-first, not name-first, still: the dialog opens a picker rather
         than a text field, because the session name is DERIVED from the folder
         and typing one produced sessions that no other client could group. -->
    <p v-if="sessions.error" class="error">{{ sessions.error }}</p>

    <NewSessionDialog
      v-if="creating"
      :start-in="creating.startIn"
      @started="onSessionStarted"
      @close="creating = null"
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
   splitter, so the two headers read as one line.

   The LEFT padding is --sp-2, not --sp-3: ghost icon buttons carry their own
   inner inset, and the old padding plus theirs pushed the back arrow visibly
   off the panel's left rhythm.

   The RIGHT padding is --sp-1, and the asymmetry is doing work rather than
   drifting. The left end is a single arrow whose glyph lines up with the dots
   and labels below it; the right end is a RUN of five ghost squares, each
   already carrying ~7px of its own optical inset, so a further 8px there is
   inset on top of inset. Halving it is also exactly what makes the strip fit
   the 200px drag floor with nothing shrunk — the arithmetic is in the template,
   above `.header-actions`. The alignment argument and the width arithmetic want
   the same thing, which is the only reason to spend an asymmetry on it. */
.tree-header {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  height: var(--topbar-h);
  flex: 0 0 auto;
  padding: 0 var(--sp-1) 0 var(--sp-2);
  border-bottom: 1px solid var(--border);
}
.header-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  margin-left: auto;
}
/* Pressed state for the overflow trigger, so an open menu is legible as
   belonging to this button. */
.icon-btn.on {
  color: var(--fg);
  background: var(--state-hover);
}
.folder-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2) 0;
}
.folder {
  margin-bottom: var(--sp-1);
}
/* A <div>, so the button reset this used to carry — background, border, color,
   text-align, cursor, font-family/size/line-height — is all gone: everything in
   that list is either the element's own default or inherited from `body`. Only
   the weight is a real decision and it stays.

   The row still gets no BACKGROUND on hover: a lift under the cursor advertises
   a click, and this row does not take one. The `:hover` rule it does have
   reveals the `+` inside it and touches nothing else, which says the opposite
   of a lift — the row is inert, and the one thing in it that is not says so by
   appearing. */
.folder-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--row-h);
  padding: 0 var(--row-pad-x) 0 var(--sp-3);
  font-weight: var(--fw-semibold);
  overflow: hidden;
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
/* ── The per-root `+`: revealed, not persistent ────────────────────────────
   HOVER- AND FOCUS-REVEALED, and this is the decision the control turned on.

   Persistent was the alternative and it is affordable on width — the root
   labels are short words (`git`, `tmp`) and a 24px square leaves plenty at the
   200px floor. What it is not affordable on is NOISE: one `+` per root is a
   column of identical marks running down a panel whose entire job is to be
   scanned, repeating an affordance that is identical on every row. VS Code's
   tree-row actions reach the same conclusion for the same reason.

   Two rules make the reveal honest rather than merely quiet:

     - it is `opacity`, never `display`. The square is always laid out, so the
       root label never reflows when the cursor arrives — a row that changes
       width under the pointer is worse than a mark that was always there.
     - `:focus-visible` reveals it too, so it is fully reachable by keyboard and
       VISIBLE once reached. A hover-only affordance is one a keyboard user can
       tab into and not see, which is the failure mode this pattern usually
       ships with.

   `@media (hover: none)` shows it unconditionally: a pointer that cannot hover
   would otherwise never reveal it at all.

   What it is deliberately NOT conditioned on is whether the root is empty. An
   empty registered root is the `+`'s most useful case, but `directories.length`
   changes under the sessions store's refresh timer, so keying visibility off it
   would make the control appear and disappear as sessions come and go — the
   same trap the root rows' own comment records about expansion state. Every
   root row carries the same mark, always, in the same place. */
.root-add {
  flex: none;
  margin-left: var(--sp-1);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.folder-header:hover .root-add,
.root-add:focus-visible {
  opacity: 1;
}
/* `.folder-header` clips (`overflow: hidden`), which would eat a +2px ring. */
.root-add:focus-visible {
  outline-offset: -2px;
}
@media (hover: none) {
  .root-add {
    opacity: 1;
  }
}
.dir-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
/* ── The indent budget, in one place ───────────────────────────────────────
   TWO levels, and no chevron column on either of them now that a root row is a
   header rather than a node. The column both rows share is the DOT, because it
   is the one element every row type has; the labels follow it at a constant
   16px (8px dot + an --sp-2 gap).

     level        dot    label
     root          12      28
     folder        20      36

   The root's 12px is --sp-3 rather than the --sp-2 the chevron used to start
   at: with the mark gone, an 8px inset put the dot hard against the panel edge
   and the root read as unindented rather than as the outer level. The folder
   step stays 8px — 18px of padding plus its 2px selection rail — which is the
   whole of the nesting this panel expresses.

   Dropping the chevron gives every row 18px back. At the 200px panel floor the
   timestamp is already gone (see the container query at the bottom of this
   block) and a folder row has 200 - 36 - 10 = 154px for its label, badges and
   count. Middle truncation is kept anyway: `pocketshell` and
   `pocketshell-desktop` are still one root apart. */
/* Sits in the folder slot, but is prose rather than a row: no dot, so
   it starts where a directory LABEL starts (36) instead of where its dot
   does. */
.empty-root {
  height: var(--row-h);
  display: flex;
  align-items: center;
  padding: 0 var(--row-pad-x) 0 36px;
  font-size: var(--fs-200);
  font-style: italic;
}
/* One step in from the root header: 18px of padding plus the 2px rail puts the
   dot at 20, 8px right of the root's. */
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
