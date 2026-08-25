<script setup lang="ts">
// Settings: the app-level preferences screen.
//
// WHERE THIS LIVES, AND WHY IT IS AN OVERLAY
//
// Ports and Usage are overlays because they are HOST-level and belong to the
// workspace header. Settings are app-level, so on the face of it they belong
// somewhere else entirely — a route. They are still an overlay, for two
// reasons that both come out of this app's structure rather than out of taste:
//
//   - A route would unmount the workspace. `/settings` as a top-level route
//     replaces HostWorkspaceView, which owns the terminal; leaving the screen
//     to flip a switch would tear down xterm and take the user's scrollback
//     with it. That is a real cost the Ports overlay was already avoiding.
//   - It has to be reachable with no connection. `defaultHost` is a decision
//     about STARTUP, so the host picker is precisely where a user goes looking
//     for it. An overlay is the only host-agnostic surface this app has: the
//     same component, opened from the picker's header and from the workspace's,
//     over whatever is behind it.
//
// So: one view, mounted inside `OverlayPanel` by two callers. It renders no
// heading of its own — the overlay chrome owns the title (see UsageView's
// `embedded` prop and the duplicated-heading note in OverlayPanel).
import { computed, onMounted } from 'vue';
import AppIcon from '../components/AppIcon.vue';
import { useConnectionStore } from '../stores/connection';
import { useSettingsStore } from '../stores/settings';
import { defaultHostStatus } from '../autoConnect';

const connection = useConnectionStore();
const settings = useSettingsStore();

onMounted(async () => {
  // The picker loads hosts on its own mount, but the workspace does not
  // re-read the config, and this panel opens over both. `listConfigHosts()` is
  // the single source for the default-host choices, so ask for it when the
  // list is empty rather than rendering an empty select.
  if (!connection.hosts.length) await connection.loadHosts();
});

/**
 * A stored default naming a host that is no longer in ~/.ssh/config. The value
 * is deliberately still shown as selected and still stored — the user set it,
 * and silently dropping it would hide the fact that their config changed.
 */
const defaultMissing = computed(
  () => defaultHostStatus(settings.defaultHost, connection.hosts) === 'missing',
);

function onDefaultHostChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  // '' is the "no default" option; the store's parser normalises it to null.
  settings.set('defaultHost', value === '' ? null : value);
}
</script>

<template>
  <div class="settings">
    <section class="group">
      <h3 class="group-title">Startup</h3>
      <div class="row">
        <div class="row-text">
          <label class="row-label" for="default-host">Default host</label>
          <p class="row-hint">
            Connect to this host as soon as PocketShell starts and go straight to its
            sessions. Choose <em>Always show the host list</em> to keep the picker.
          </p>
        </div>
        <select
          id="default-host"
          class="control"
          :value="settings.defaultHost ?? ''"
          @change="onDefaultHostChange"
        >
          <option value="">Always show the host list</option>
          <!-- The stale value keeps its own option so the select can still
               display it; without this the control would silently snap to
               "always show", which is not what is stored. -->
          <option v-if="defaultMissing" :value="settings.defaultHost ?? ''">
            {{ settings.defaultHost }} (not in ~/.ssh/config)
          </option>
          <option v-for="host in connection.hosts" :key="host.name" :value="host.name">
            {{ host.name }}
          </option>
        </select>
      </div>
      <p v-if="defaultMissing" class="notice">
        <AppIcon name="alert-triangle" :size="14" />
        <span>
          <strong>{{ settings.defaultHost }}</strong> is not in <code>~/.ssh/config</code> any
          more, so PocketShell starts on the host list until you pick a new default.
        </span>
      </p>
    </section>

    <section class="group">
      <h3 class="group-title">Prompt composer</h3>

      <div class="row">
        <div class="row-text">
          <span class="row-label">Typing opens the composer</span>
          <p class="row-hint">
            Typing in the terminal opens the prompt composer and the keystrokes go into
            it, instead of straight to the shell.
          </p>
        </div>
        <button
          class="switch"
          role="switch"
          :aria-checked="settings.typingOpensComposer"
          :class="{ on: settings.typingOpensComposer }"
          @click="settings.set('typingOpensComposer', !settings.typingOpensComposer)"
        >
          <AppIcon :name="settings.typingOpensComposer ? 'toggle-right' : 'toggle-left'" />
          <span>{{ settings.typingOpensComposer ? 'On' : 'Off' }}</span>
        </button>
      </div>

      <div class="row">
        <div class="row-text">
          <span class="row-label">Close the composer after sending</span>
          <p class="row-hint">
            The composer closes itself once a message is sent, and reopens the next time
            you type.
          </p>
        </div>
        <button
          class="switch"
          role="switch"
          :aria-checked="settings.closeComposerOnSend"
          :class="{ on: settings.closeComposerOnSend }"
          @click="settings.set('closeComposerOnSend', !settings.closeComposerOnSend)"
        >
          <AppIcon :name="settings.closeComposerOnSend ? 'toggle-right' : 'toggle-left'" />
          <span>{{ settings.closeComposerOnSend ? 'On' : 'Off' }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  padding: var(--sp-4);
}
.group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
/* The section header metric from the session panel: small, uppercase, tracked.
   It is the app's existing "this is a group of things" mark. */
.group-title {
  margin: 0;
  font-size: var(--fs-100);
  line-height: var(--lh-100);
  font-weight: var(--fw-semibold);
  color: var(--fg-muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
/* Label left, control right, hairline between rows — the shape every settings
   list in every desktop app has, so nothing here needs to be learned. */
.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--border-soft);
}
.row:last-child {
  border-bottom: none;
}
.row-text {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}
.row-label {
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  color: var(--fg);
}
/* --fg-secondary, not --fg-muted: this is real information at 12px, and
   --fg-muted is 4.12:1 (docs/DESIGN.md §4.2 restricts it to >=15px). */
.row-hint {
  margin: 0;
  max-width: 46ch;
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  color: var(--fg-secondary);
}
.control {
  flex: none;
  height: var(--control-h);
  background: var(--surface-2);
  /* WCAG 1.4.11: a control's boundary needs >=3:1; --border is 1.49:1. */
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  padding: 0 var(--sp-2);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  max-width: 16rem;
}
/* A labelled two-state control, not a bordered box: the mark itself changes
   shape (toggle-left/toggle-right), so on and off differ without relying on
   the tint. Ghost at rest like the rest of the app's chrome. */
.switch {
  flex: none;
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-2);
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.switch.on {
  color: var(--accent);
}
.switch:hover {
  background: var(--state-hover);
}
.notice {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  color: var(--warning);
  background: var(--warning-soft);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
code {
  font-family: var(--font-mono);
  font-size: 0.9em;
}
</style>
