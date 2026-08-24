<script setup lang="ts">
// Host picker: reads ~/.ssh/config, lists hosts, and connects on click.
// After a successful connect it navigates to the host workspace, where the
// session tree + terminal live.
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useConnectionStore } from '../stores/connection';
import AppIcon from '../components/AppIcon.vue';
import type { HostEntry } from '../../shared/types';

const router = useRouter();
const connection = useConnectionStore();
const connectError = ref<string | null>(null);
const connectingTo = ref<string | null>(null);

onMounted(async () => {
  await connection.loadHosts();
});

async function onConnect(host: HostEntry): Promise<void> {
  connectError.value = null;
  connectingTo.value = host.name;
  const ok = await connection.connect(host);
  connectingTo.value = null;
  if (ok) {
    // Land on the host's default view: the session list. `void`: vue-router
    // rejects on aborted/redirected navigation, neither of which is an error.
    void router.push({ name: 'host-sessions', params: { name: host.name } });
  } else {
    connectError.value = connection.error ?? 'Connection failed';
  }
}
</script>

<template>
  <div class="picker">
    <header>
      <h1>PocketShell</h1>
    </header>
    <main>
      <p v-if="!connection.hosts.length && !connection.error" class="muted">
        No hosts found in <code>~/.ssh/config</code>. Add one there to get started.
      </p>
      <ul class="host-list">
        <li v-for="host in connection.hosts" :key="host.name">
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
        </li>
      </ul>
      <p v-if="connectError" class="error">{{ connectError }}</p>
    </main>
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
.host-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
/* The one place a taller, card-like row is right: this is a landing screen,
   not a dense list. Matches the Android HostCard's 14dp/44dp geometry. */
.host-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 44px;
  text-align: left;
  background: var(--surface);
  color: var(--fg);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  padding: var(--sp-2) var(--sp-4);
  margin-bottom: var(--sp-2);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
/* Hover is a neutral lift + a stronger edge. Accent is reserved for
   *selected*, never for hover. */
.host-row:hover:not(:disabled) {
  background: var(--state-hover);
  border-color: var(--border-strong);
}
.host-row:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
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
