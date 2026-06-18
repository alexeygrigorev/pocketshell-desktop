<script setup lang="ts">
// Host picker: reads ~/.ssh/config, lists hosts, and connects on click.
// After a successful connect it navigates to the host workspace, where the
// session tree + terminal live.
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useConnectionStore } from '../stores/connection';
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
    router.push({ name: 'host', params: { name: host.name } });
  } else {
    connectError.value = connection.error ?? 'Connection failed';
  }
}
</script>

<template>
  <div class="picker">
    <header>
      <h1>PocketShell</h1>
      <span class="badge">select a host</span>
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
            <span class="host-name">{{ host.name }}</span>
            <span class="host-detail">
              {{ host.user || '(default user)' }}@{{ host.hostname }}:{{ host.port }}
            </span>
            <span v-if="connectingTo === host.name" class="muted">connecting…</span>
            <span v-else class="muted">→</span>
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
  padding: 2rem 1.5rem;
}
header {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  border-bottom: 1px solid var(--border);
  padding-bottom: 1rem;
  margin-bottom: 1.5rem;
}
h1 {
  margin: 0;
  font-size: 1.5rem;
}
.badge {
  color: var(--muted);
  font-size: 0.8rem;
  border: 1px solid var(--border);
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}
.host-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.host-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  text-align: left;
  background: transparent;
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  margin-bottom: 0.5rem;
  cursor: pointer;
  font-size: 0.95rem;
}
.host-row:hover:not(:disabled) {
  border-color: var(--accent);
  background: rgba(137, 180, 250, 0.06);
}
.host-row:disabled {
  opacity: 0.6;
  cursor: default;
}
.host-name {
  font-weight: 600;
}
.host-detail {
  color: var(--muted);
  font-family: ui-monospace, monospace;
  font-size: 0.85rem;
  flex: 1;
}
.muted {
  color: var(--muted);
}
.error {
  color: var(--error);
}
code {
  background: var(--border);
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  font-size: 0.9em;
}
</style>
