<script setup lang="ts">
// Host picker: reads ~/.ssh/config, lists hosts, and connects on click.
// After a successful connect it navigates to the host workspace, where the
// session tree + terminal live.
//
// It is also the launch screen, so it owns the auto-connect to the user's
// default host. The rules for that decision are in ../autoConnect.ts; what
// lives here is only the dialling and the escape hatches, which are the part
// that matters:
//
//   - THE PICKER IS NEVER REPLACED BY A SPINNER. The host list stays on screen
//     for the whole attempt, with a banner above it. There is no state in which
//     the user is looking at a screen with nothing to press.
//   - CANCEL IS ALWAYS VISIBLE while dialling. Pressing it abandons the attempt
//     immediately from the user's point of view, and hangs up on the connection
//     if it lands afterwards, so a cancelled auto-connect cannot leave a live
//     link the user did not ask for.
//   - NO EXTRA RENDERER-SIDE TIMEOUT. `SshService.connect` already caps the
//     dial at DEFAULT_TIMEOUT_MS (30s) and resolves — never rejects — with a
//     real diagnostic. A second timer here would race it and would usually win,
//     replacing "All configured authentication methods failed" with a useless
//     "timed out". A bounded backstop plus an instant manual escape is what
//     "escapable" needs, and the bound already exists one layer down.
//   - A FAILED AUTO-CONNECT LEAVES THE DEFAULT ALONE. The error is shown on the
//     picker; the setting stays set, because a host being down is not a reason
//     to forget which host the user wants.
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useConnectionStore } from '../stores/connection';
import { useSettingsStore } from '../stores/settings';
import {
  autoConnectAttempted,
  decideAutoConnect,
  defaultHostStatus,
  markAutoConnectAttempted,
} from '../autoConnect';
import AppIcon from '../components/AppIcon.vue';
import OverlayPanel from '../components/OverlayPanel.vue';
import SettingsView from './SettingsView.vue';
import type { HostEntry } from '../../shared/types';

const router = useRouter();
const connection = useConnectionStore();
const settings = useSettingsStore();
const connectError = ref<string | null>(null);
const connectingTo = ref<string | null>(null);
const settingsOpen = ref(false);

/** True while the in-flight dial was started by the app, not by a click. */
const autoConnecting = ref(false);
/** Set by Cancel; read when the dial finally resolves. */
let autoConnectCancelled = false;

const defaultMissing = computed(
  () => defaultHostStatus(settings.defaultHost, connection.hosts) === 'missing',
);

onMounted(async () => {
  await connection.loadHosts();
  const decision = decideAutoConnect({
    defaultHost: settings.defaultHost,
    hosts: connection.hosts,
    attempted: autoConnectAttempted(),
    connected: connection.connectionId !== null,
  });
  if (decision.action === 'connect') await runAutoConnect(decision.host);
});

async function runAutoConnect(host: HostEntry): Promise<void> {
  // Latch BEFORE dialling: whatever happens next — success, failure, cancel,
  // a hang that the user escapes — this launch has had its one attempt. This
  // is what stops Back from the workspace bouncing straight back in.
  markAutoConnectAttempted();
  autoConnectCancelled = false;
  autoConnecting.value = true;
  const ok = await dial(host);
  autoConnecting.value = false;
  if (autoConnectCancelled) {
    // The dial won the race with the Cancel click. Hang up rather than leaving
    // a connection the user explicitly abandoned — but only if this is still
    // the connection in hand. `connect()` claims `activeHost` synchronously, so
    // a different name here means the user already started dialling somewhere
    // else in the meantime and tearing "the" connection down would tear down
    // theirs. The abandoned link then survives until the app exits, which is
    // the cheaper of the two failures by a wide margin.
    if (ok && connection.activeHost?.name === host.name) await connection.disconnect();
    connectError.value = null;
    return;
  }
  if (ok) enterWorkspace(host);
}

function onCancelAutoConnect(): void {
  autoConnectCancelled = true;
  autoConnecting.value = false;
  connectingTo.value = null;
}

async function onConnect(host: HostEntry): Promise<void> {
  if (await dial(host)) enterWorkspace(host);
}

/**
 * The one dialling path, shared by the click and by auto-connect, so the two
 * cannot drift. In particular `connection.connect` is what supplies
 * `privateKeyPath` (it falls back to the host's `identityFile`) and the TOFU
 * decision, and neither has an auto-connect-specific variant — an automatic
 * dial gets exactly the credentials and exactly the host-key treatment a
 * clicked one does.
 */
async function dial(host: HostEntry): Promise<boolean> {
  connectError.value = null;
  connectingTo.value = host.name;
  const ok = await connection.connect(host);
  connectingTo.value = null;
  if (!ok) connectError.value = connection.error ?? 'Connection failed';
  return ok;
}

function enterWorkspace(host: HostEntry): void {
  // Land on the host's default view: the session list. `void`: vue-router
  // rejects on aborted/redirected navigation, neither of which is an error.
  void router.push({ name: 'host-sessions', params: { name: host.name } });
}

/** The star on a row: make this host the default, or clear it. */
function onToggleDefault(host: HostEntry): void {
  settings.set('defaultHost', settings.defaultHost === host.name ? null : host.name);
}
</script>

<template>
  <div class="picker">
    <header>
      <h1>PocketShell</h1>
      <button class="icon-btn settings-btn" title="Settings" @click="settingsOpen = true">
        <AppIcon name="settings" />
      </button>
    </header>
    <main>
      <!-- The escape hatch. It sits above the list, and the list stays usable
           underneath, so an auto-connect is something happening ON the picker
           rather than instead of it. -->
      <p v-if="autoConnecting" class="auto-banner">
        <span>Connecting to <strong>{{ connectingTo }}</strong> (your default host)…</span>
        <button class="btn-ghost" @click="onCancelAutoConnect">Cancel</button>
      </p>
      <p v-if="defaultMissing && !autoConnecting" class="auto-banner stale">
        <AppIcon name="alert-triangle" :size="14" />
        <span>
          Your default host <strong>{{ settings.defaultHost }}</strong> is not in
          <code>~/.ssh/config</code> any more.
        </span>
        <button class="btn-ghost" @click="settings.set('defaultHost', null)">Clear</button>
      </p>
      <p v-if="!connection.hosts.length && !connection.error" class="muted">
        No hosts found in <code>~/.ssh/config</code>. Add one there to get started.
      </p>
      <ul class="host-list">
        <!-- The card is the <li>, not the row button: the "make this the
             default" star is a second control on the same card, and a button
             inside a button is invalid. -->
        <li v-for="host in connection.hosts" :key="host.name" class="host-item">
          <button
            class="host-row"
            :disabled="connectingTo !== null"
            @click="onConnect(host)"
          >
            <!-- Mirrors the Android StatusDot: the desktop used to show
                 connection state only as the word "connecting…". -->
            <span class="status-dot" :class="{ connecting: connectingTo === host.name }" />
            <span class="host-name">{{ host.name }}</span>
            <span class="host-detail">
              {{ host.user || '(default user)' }}@{{ host.hostname }}:{{ host.port }}
            </span>
            <span v-if="connectingTo === host.name" class="muted">connecting…</span>
            <!-- A list row that goes somewhere gets a chevron, not an arrow
                 (VS Code / macOS convention). -->
            <AppIcon v-else name="chevron-right" class="chevron" />
          </button>
          <button
            class="icon-btn star"
            :class="{ on: settings.defaultHost === host.name }"
            :title="
              settings.defaultHost === host.name
                ? 'Stop connecting to this host on startup'
                : 'Connect to this host on startup'
            "
            :aria-pressed="settings.defaultHost === host.name"
            @click="onToggleDefault(host)"
          >
            <AppIcon :name="settings.defaultHost === host.name ? 'star-filled' : 'star'" />
          </button>
        </li>
      </ul>
      <p v-if="connectError" class="error">{{ connectError }}</p>
    </main>

    <!-- App-level, so it is reachable here with no connection at all — which
         is the whole point, since the default-host setting is about startup. -->
    <OverlayPanel v-if="settingsOpen" title="Settings" size="md" @close="settingsOpen = false">
      <SettingsView />
    </OverlayPanel>
  </div>
</template>

<style scoped>
.picker {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--sp-6) var(--sp-5);
}
header {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  border-bottom: 1px solid var(--border);
  padding-bottom: var(--sp-4);
  margin-bottom: var(--sp-5);
}
h1 {
  margin: 0;
  font-size: var(--fs-600);
  line-height: var(--lh-600);
  font-weight: var(--fw-bold);
  color: var(--fg);
}
/* Trails the wordmark. `align-self` because the header baseline-aligns its
   children and an icon button has no baseline worth aligning to. */
.settings-btn {
  margin-left: auto;
  align-self: center;
}
/* Status strip above the list: the app is doing something, the list is still
   there, and the way out is in the same line as the message. */
.auto-banner {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-3);
  padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  color: var(--fg-secondary);
}
.auto-banner button {
  margin-left: auto;
}
.auto-banner.stale {
  color: var(--warning);
  background: var(--warning-soft);
  border-color: transparent;
}
.host-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
/* The one place a taller, card-like row is right: this is a landing screen,
   not a dense list. Matches the Android HostCard's 14dp/44dp geometry. */
.host-item {
  display: flex;
  align-items: center;
  min-height: 44px;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  margin-bottom: var(--sp-2);
  padding-right: var(--sp-2);
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
/* Hover is a neutral lift + a stronger edge. Accent is reserved for
   *selected*, never for hover. Keyed off the ROW so that hovering the star
   alone does not light up the whole card — they are two different actions. */
.host-item:has(.host-row:hover:not(:disabled)) {
  background: var(--state-hover);
  border-color: var(--border-strong);
}
.host-row {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  align-self: stretch;
  text-align: left;
  background: transparent;
  color: var(--fg);
  border: none;
  border-radius: var(--r-lg);
  padding: var(--sp-2) var(--sp-3) var(--sp-2) var(--sp-4);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
}
.host-row:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* Quiet until it means something: an unset star is a decorative mark, a set
   one is the accent because it IS a selection — this host, on startup. */
.star {
  color: var(--fg-muted);
}
.star.on,
.star.on:hover {
  color: var(--accent);
}
.status-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--fg-muted);
}
.status-dot.connecting {
  background: var(--warning);
  animation: pulse 1.2s var(--ease) infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
/* No local prefers-reduced-motion block: App.vue carries one global guard
   that covers this pulse along with every other animation. */
.host-name {
  font-size: var(--fs-400);
  line-height: var(--lh-400);
  font-weight: var(--fw-semibold);
}
.host-detail {
  color: var(--fg-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-200);
  flex: 1;
}
/* A 2px nudge on row hover — the smallest possible "this row goes somewhere"
   cue. Colour and transform only; the row's own tint does the rest. */
.chevron {
  color: var(--fg-muted);
  transition:
    color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}
.host-row:hover:not(:disabled) .chevron {
  color: var(--fg-secondary);
  transform: translateX(2px);
}
.error {
  font-size: var(--fs-300);
}
code {
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  font-family: var(--font-mono);
  font-size: 0.9em;
}
</style>
