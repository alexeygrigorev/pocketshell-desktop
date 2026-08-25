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
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useConnectionStore } from '../stores/connection';
import { useSessionsStore } from '../stores/sessions';
import { useFilesStore } from '../stores/files';
import { useComposerStore } from '../stores/composer';
import { useSettingsStore } from '../stores/settings';
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
const files = useFilesStore();
const composer = useComposerStore();
const settings = useSettingsStore();

const tab = ref<'terminal' | 'conversation' | 'files'>('terminal');

/**
 * A path clicked in the terminal brings the Files tab forward.
 *
 * The store only PARKS the request; it cannot act on it, because FilesView is
 * behind a v-if and has to be mounted first. FilesView takes the request in its
 * own onMounted, AFTER files.open() has restored the remembered directory —
 * which would otherwise run second and undo the reveal.
 */
watch(
  () => files.reveal,
  (target) => {
    if (target != null) tab.value = 'files';
  },
);

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

/** Same reasoning for the composer, whose `typeInto` the terminal feeds. */
const composerRef = ref<{ typeInto: (text: string) => void } | null>(null);

/**
 * Whether the terminal should withhold printable keystrokes instead of sending
 * them to the shell (docs/COMPOSER.md §26).
 *
 * The two halves of the condition live here rather than in either component:
 * the SETTING is app-level, and "only while the composer is closed" is a fact
 * about the composer. TerminalView is handed the answer, so it needs to know
 * about neither. Being a computed, it also tracks both at runtime — flipping
 * the switch in Settings changes the very next keystroke.
 */
const interceptTyping = computed(
  () => settings.typingOpensComposer && composer.mode === 'hidden' && tab.value !== 'files',
);

/** A keystroke the terminal withheld: it belongs in the draft, not the shell. */
function onTyped(text: string): void {
  composerRef.value?.typeInto(text);
}

/**
 * Put the keyboard back in the pane — Escape rung 3, and every path that
 * closes the composer, which must hand focus back or the next keystroke has
 * nowhere to go and `typingOpensComposer` never fires.
 *
 * It deliberately does NOT switch tabs any more. It used to, which was
 * defensible while this was only Escape's business; now that closing the panel
 * routes through it too, being thrown from Conversation to Terminal for
 * dismissing a card would be a non-sequitur. On the other tabs the blur the
 * caller already did is the whole of the job.
 */
function onFocusTerminal(): void {
  if (tab.value !== 'terminal') return;
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
      <div class="tab-body">
        <!-- Terminal: kept mounted so switching tabs never drops the attach. -->
        <div v-show="tab === 'terminal'" class="terminal-area">
          <TerminalView
            v-if="connection.connectionId && sessionName"
            ref="terminalRef"
            :connection-id="connection.connectionId"
            :command="command"
            :session-key="sessionName"
            :intercept-typing="interceptTyping"
            @typed="onTyped"
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
          ref="composerRef"
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

  /* The gap between the floating composer and this pane's edges — what makes
     it read as hovering rather than as a bar welded to the window. Declared
     here rather than in App.vue's :root because it describes THIS pane's
     relationship with the composer, and custom properties inherit, so
     PromptComposer reads the same number without being handed it.
     `--composer-rail-h` used to sit beside it, sizing a strip reserved out of
     the terminal for the collapsed toggle. There is no such strip any more
     (see `.tab-body` below), and the toggle sizes itself from --control-h-sm. */
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
/*
 * NO ROOM IS RESERVED FOR THE COMPOSER. It used to keep `rail + inset` of
 * padding here permanently — about two terminal rows, given up whether the
 * composer was open or shut — so that the collapsed toggle could sit below
 * the last row rather than on top of it. The user asked for those rows back:
 * the composer should fly over the terminal, not take a slice of it.
 *
 * THE ROW-COUNT GUARANTEE SURVIVES THIS. It never depended on the padding being
 * 44px, only on its being a CONSTANT: the terminal is sized once, by the pane,
 * and no composer state can change it. Zero is a constant. Opening, closing,
 * dragging and resizing the card still cause no SSH window-change and no remote
 * tmux reflow — the guarantee simply settles at a larger row count now.
 *
 * What it does cost: the toggle floats over the bottom-right of the terminal,
 * where tmux paints the right end of its status line. That is deliberate and
 * the toggle is styled to defer to it (see `.rail` in PromptComposer.vue).
 */
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
 * behind it. The composer is an overlay instead, contributing nothing to the tab
 * body's layout, so the terminal is sized once by the pane and STAYS that size
 * whatever the panel does. It used to also reserve a strip of padding for the
 * collapsed toggle; see `.tab-body` above for why that went and why the
 * guarantee did not go with it.
 *
 * Why the dock is the WHOLE body and not a strip at the bottom.
 *
 * Because the card MOVES. The user drags it anywhere in the pane, so the box it
 * is confined to has to be the pane, and every clamp in
 * src/shared/composerGeometry.ts is measured against this element. It also
 * gives the card's percentages something definite to resolve against, which an
 * auto-height strip could not.
 *
 * What it does NOT do is take part in the tab body's layout, in any state. That
 * is the whole reason moving or resizing the card cannot alter the terminal's
 * row count, whatever corner the user drags it into.
 *
 * The composer's fixed open/close toggle is pinned to this dock's bottom-right
 * corner, and PromptComposer keeps the draggable card out of that corner's box.
 * That is what makes the toggle un-coverable in every card position — it is a
 * hole in the card's placement, not a band carved out of the pane.
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
