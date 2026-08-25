<script setup lang="ts">
// SessionWorkspaceView: everything scoped to ONE session, rendered in the host
// workspace's right pane. The tabs live here (Terminal / Conversation / Files)
// rather than at the host level, so what you switch between is always
// "this session's ...". The session list stays visible in the left panel.
//
// Two structural notes:
//   - The terminal pane stays mounted (v-show, not v-if) across tab switches;
//     unmounting it would close the SSH shell and drop the tmux attach.
//   - `.session-body` is a column whose tab content flexes, leaving the bottom
//     of this pane free for the prompt composer, which docks there.
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
    <header class="session-bar">
      <span class="session-name">{{ sessionName }}</span>
      <span v-if="sessionPath" class="session-path muted">{{ sessionPath }}</span>
      <button class="icon-btn close" title="Close session view" @click="onCloseSession">
        <AppIcon name="close" />
      </button>
    </header>

    <nav class="tabs">
      <button :class="['tab', { active: tab === 'terminal' }]" @click="tab = 'terminal'">
        Terminal
      </button>
      <button :class="['tab', { active: tab === 'conversation' }]" @click="tab = 'conversation'">
        Conversation
      </button>
      <button :class="['tab', { active: tab === 'files' }]" @click="tab = 'files'">Files</button>
    </nav>

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
           same thing: v-if unmounts either way, v-show keeps it alive. -->
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
}
.session-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  height: var(--topbar-h);
  flex: 0 0 auto;
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.session-name {
  font-family: var(--font-mono);
  font-size: var(--fs-400);
  line-height: var(--lh-400);
  font-weight: var(--fw-semibold);
}
.session-path {
  font-family: var(--font-mono);
  font-size: var(--fs-200);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.close {
  margin-left: auto;
  flex-shrink: 0;
}
/* Underline tabs, not Android's filled segmented control: a solid cyan
   segment at 13px in a 32px strip is heavy for a mouse UI. See DESIGN.md §5.4. */
.tabs {
  display: flex;
  gap: var(--sp-1);
  height: var(--tabbar-h);
  flex: 0 0 auto;
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
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
/* The composer's collapsed rail — the ONE part of it that is never floating.
   Kept in sync with `.rail { height: 32px }` in PromptComposer.vue. */
.tab-body.with-composer {
  padding-bottom: var(--composer-rail-h);
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
 * behind it.
 *
 * The rail's 32px is reserved permanently by `.tab-body.with-composer`
 * instead, so the terminal is sized as though the composer were closed and
 * STAYS that size whatever the panel does. tmux's status bar stays visible at
 * the bottom of the pane; only the expanded panel covers terminal rows, and
 * only while it is expanded.
 */
.composer-dock {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* Backstop inherited from the docked layout's reasoning, re-aimed: it used
     to stop the panel starving the terminal of height, which an overlay can no
     longer do. It now stops the panel COVERING the whole terminal. */
  max-height: 80%;
  /* Reads as floating rather than as a pane that has always been there, and
     stops terminal text appearing to run into the composer's top edge. */
  box-shadow: 0 -8px 24px rgb(0 0 0 / 0.35);
}
/*
 * The panel remembers an absolute pixel height, and `.composer` is
 * `flex: 0 0 auto`, which cannot shrink. Inside an auto-height absolute box,
 * its own `max-height: 80%` resolves against nothing and is dropped — so the
 * dock's cap is what has to bite, and the panel has to be allowed to shrink
 * for it to.
 */
.composer-dock :deep(.composer) {
  flex: 1 1 auto;
  min-height: 0;
}
</style>
