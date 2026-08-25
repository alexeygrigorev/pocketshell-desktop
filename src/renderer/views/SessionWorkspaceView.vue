<script setup lang="ts">
// SessionWorkspaceView: everything scoped to ONE session, rendered in the host
// workspace's right pane. The tabs live here (Terminal / Conversation / Files)
// rather than at the host level, so what you switch between is always
// "this session's ...". The session list stays visible in the left panel.
//
// Three structural notes:
//   - The terminal pane stays mounted (v-show, not v-if) across tab switches;
//     unmounting it would close the SSH shell and drop the tmux attach.
//   - The session's identity and its tabs share ONE bar. They were two
//     full-height rows, which spent 72px of every window on chrome above the
//     terminal; merging them gives --topbar-h of that back to the pane.
//   - `.session-body` is the composer's stage: the card floats over the tab
//     content inside it rather than docking below, and the body reserves a
//     constant strip at the bottom so the terminal's size never depends on
//     what the composer is doing.
//
// The composer is mounted ONCE here, outside `.tab-body` and never behind a
// `v-if` on the tab, so the draft, caret and staged attachments survive a tab
// switch. It is hidden (v-show) on Files, which has its own surface.
// See docs/COMPOSER.md §11.
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useConnectionStore } from '../stores/connection';
import { useSessionsStore } from '../stores/sessions';
import AppIcon from '../components/AppIcon.vue';
import TerminalView from '../components/TerminalView.vue';
import PromptComposer from '../components/PromptComposer.vue';
import ConversationView from './ConversationView.vue';
import FilesView from './FilesView.vue';
import { composerAgentKind } from '../../shared/composerSend';
import { sessionAttachCommand } from '../../shared/attachCommand';

const route = useRoute();
const router = useRouter();
const connection = useConnectionStore();
const sessions = useSessionsStore();

const tab = ref<'terminal' | 'conversation' | 'files'>('terminal');

/** Session name from the route — the single source of truth for this view. */
const sessionName = computed(() => String(route.params['session'] ?? ''));

/** The matching summary row, when the sessions store has been populated. */
const summary = computed(() => sessions.sessions.find((s) => s.name === sessionName.value) ?? null);

/** Working directory of the session, used to seed the Files tab. */
const sessionPath = computed(() => summary.value?.path ?? undefined);

/**
 * The name's tooltip. The path used to have a line of its own in the header;
 * now that the header is one row it lives here, because the session name is
 * derived from that path and rendering both spends the tabs' width restating a
 * fact the name already carries.
 */
const sessionTitle = computed(() =>
  sessionPath.value ? `${sessionName.value}\n${sessionPath.value}` : sessionName.value,
);

/**
 * The engine recorded host-side for this session, narrowed to what the composer
 * can route to. This is what lights up its slash-command catalog: an agent
 * session gets the dropdown, a shell never does (docs/COMPOSER.md §18).
 */
const agentKind = computed(() => composerAgentKind(summary.value?.agentKind));

const command = computed(() => {
  if (!sessionName.value) return undefined;
  return sessionAttachCommand(sessionName.value);
});

onMounted(async () => {
  // Deep-linking straight to a session (or a reload) can leave the store empty;
  // refresh so the header/Files tab get the session's path.
  if (connection.connectionId && !sessions.sessions.length) {
    await sessions.refresh(connection.connectionId);
  }
});

/** Deselect: back to the right pane's empty state, panel untouched. */
function onCloseSession(): void {
  // `void`: vue-router rejects on aborted/redirected navigation, neither of
  // which is an error here.
  void router.push({ name: 'host-sessions', params: { name: route.params['name'] as string } });
}

/**
 * Template ref on the terminal, so the composer's Escape ladder can un-focus.
 * Typed by the one method we call rather than `InstanceType<typeof
 * TerminalView>`: `*.vue` is declared as a `DefineComponent<…, any>` in
 * env.d.ts, so that instance type collapses to `any` and takes the call site
 * with it.
 */
const terminalRef = ref<{ focus: () => void } | null>(null);

/** Escape rung 3: blur the draft and put the caret back in the pane. */
function onFocusTerminal(): void {
  if (tab.value !== 'terminal') tab.value = 'terminal';
  terminalRef.value?.focus();
}
</script>

<template>
  <div class="session-workspace">
    <!-- ONE row of chrome, not two. The tabs come first because they are the
         only thing here that gets clicked, and a leading identity label of
         unpredictable length would move them horizontally on every session
         switch — a control that shifts under the cursor per session is worse
         than a name that sits a little further right. The name trails, where it
         is read rather than aimed at, and truncates before the tabs ever do. -->
    <header class="session-bar">
      <nav class="tabs">
        <button :class="['tab', { active: tab === 'terminal' }]" @click="tab = 'terminal'">
          Terminal
        </button>
        <button :class="['tab', { active: tab === 'conversation' }]" @click="tab = 'conversation'">
          Conversation
        </button>
        <button :class="['tab', { active: tab === 'files' }]" @click="tab = 'files'">Files</button>
      </nav>

      <!-- The path is NOT rendered beside the name. A session is named after
           the directory it runs in, so the two are one fact written twice —
           the same redundancy the session panel dropped in b841362. The full
           path lives on the tooltip, one hover away, where it costs no width. -->
      <span class="session-name" :title="sessionTitle">{{ sessionName }}</span>

      <button class="icon-btn close" title="Close session view" @click="onCloseSession">
        <AppIcon name="close" />
      </button>
    </header>

    <div class="session-body">
      <div :class="['tab-body', { 'with-composer': tab !== 'files' }]">
        <!-- Terminal: kept mounted so switching tabs never drops the attach. -->
        <div v-show="tab === 'terminal'" class="terminal-area">
          <TerminalView
            v-if="connection.connectionId && sessionName"
            ref="terminalRef"
            :connection-id="connection.connectionId"
            :command="command"
            :session-key="sessionName"
          />
        </div>

        <ConversationView
          v-if="tab === 'conversation' && connection.connectionId"
          :session-id="sessionName"
        />

        <FilesView v-if="tab === 'files' && connection.connectionId" :start-path="sessionPath" />
      </div>

      <!-- The prompt composer FLOATS over the tab content rather than docking
           below it. Mounted once, v-show (never v-if) so a tab switch cannot
           cost the user a draft — the flags live on the dock now, which is the
           same thing: v-if unmounts either way, v-show keeps it alive.
           The dock is only the frame; the card inside it is what floats. -->
      <div
        v-if="connection.connectionId && sessionName"
        v-show="tab !== 'files'"
        class="composer-dock"
      >
        <PromptComposer
          :connection-id="connection.connectionId"
          :session-name="sessionName"
          :agent-kind="agentKind"
          :viewing-conversation="tab === 'conversation'"
          :connected="connection.state === 'connected'"
          @focus-terminal="onFocusTerminal"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-workspace {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;

  /* ---- the composer's two geometry constants ---------------------------
   * Declared here rather than in App.vue's :root because they describe THIS
   * pane's relationship with the composer, and only this pane reserves room
   * for it. Custom properties inherit, so PromptComposer — a descendant —
   * reads the same two numbers, which is the point: the space reserved below
   * and the space the card is inset by can only be kept equal if there is one
   * pair of values.
   *
   *   --composer-rail-h  the height of the collapsed rail pill.
   *   --composer-inset   the gap between the card and the pane's edges. This
   *                      is what makes it read as floating rather than as a
   *                      bar welded to the window.
   */
  --composer-rail-h: 32px;
  --composer-inset: var(--sp-3);
}
/* ---- one row of chrome ---------------------------------------------------
 * Identity and tabs used to be two full-height bars, 72px of chrome above every
 * terminal. Merged they cost --topbar-h and nothing else: the row is ONE bar
 * height rather than a compromise between two, so the saving is the whole 40px
 * the tab strip used to occupy.
 *
 * The row has no vertical padding on purpose. The tabs are full-height children
 * of it, which is what lets the active tab's 2px underline sit exactly on the
 * row's own bottom border — the treatment DESIGN.md §5.4 specifies. Centring
 * shorter tab buttons inside a taller bar would leave that underline floating
 * in mid-row with a gap beneath it.
 */
.session-bar {
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
.session-name {
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
   segment at 13px is heavy for a mouse UI. See DESIGN.md §5.4. */
.tabs {
  display: flex;
  gap: var(--sp-1);
  flex: 0 0 auto;
  padding: 0 0 0 var(--sp-3);
}
.tab {
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
.session-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  /* Containing block for .composer-dock, which is positioned against it. */
  position: relative;
}
.tab-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
/* Permanent room for the collapsed rail pill AND for the gap it floats in, so
   the pill never covers a terminal row — including tmux's status bar, which is
   the bottom one and the one worth protecting. This padding is a constant: it
   is reserved whether the composer is open, closed or mid-drag, which is what
   makes the terminal's row count independent of the composer (see below). */
.tab-body.with-composer {
  padding-bottom: calc(var(--composer-rail-h) + var(--composer-inset));
}
.terminal-area {
  flex: 1;
  min-width: 0;
  display: flex;
}

/* ---- the composer floats over the tab content --------------------------- */
/*
 * Why an overlay and not a docked row.
 *
 * Docked, the composer was a flex sibling of the tab body, so every open,
 * close, drag-resize and mode switch changed the terminal's pixel height —
 * which changes its ROW COUNT, which is an SSH window-change the remote tmux
 * has to redraw and reflow for. Typing a prompt should not reflow the session
 * behind it. `.tab-body.with-composer` reserves the rail's room permanently
 * instead, so the terminal is sized as though the composer were closed and
 * STAYS that size whatever the panel does.
 *
 * Why the dock is the WHOLE body and not a strip at the bottom.
 *
 * Because the card MOVES. The user drags it anywhere in the pane, so the box it
 * is confined to has to be the pane, and every clamp in
 * src/shared/composerGeometry.ts is measured against this element. It also
 * gives the card's percentages something definite to resolve against, which an
 * auto-height strip could not.
 *
 * What it does NOT do is change the terminal's size. The reserve below is a
 * constant; the dock is an overlay that takes no part in the tab body's layout.
 * Moving or resizing the card therefore cannot alter the terminal's row count,
 * whatever corner the user drags it into.
 *
 * The bottom — the strip the reserve pays for — belongs to the composer's
 * fixed open/close toggle, and PromptComposer keeps the draggable card out of
 * it. That is what makes the toggle un-coverable in every card position.
 */
.composer-dock {
  position: absolute;
  /* INSET rather than padded. An absolutely positioned child resolves its
     offsets against its containing block's PADDING box, so padding here would
     not have held the card off the pane's edges — and, more usefully, insetting
     the dock itself makes `right: 0; bottom: 0` mean "the resting corner". That
     is why src/shared/composerGeometry.ts never has to know what the inset is:
     the dock has already subtracted it. */
  inset: var(--composer-inset);
  z-index: 5;
  pointer-events: none;
}
/* Which parts of that overlay accept the mouse is PromptComposer's business:
   it layers a stage and a pinned toggle inside here and re-enables events on
   just those two. A blanket rule on the dock's children would have handed them
   back to the whole layer and swallowed every click meant for the terminal. */
</style>
