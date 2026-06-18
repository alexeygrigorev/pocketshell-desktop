<script setup lang="ts">
// Minimal Phase 0 shell. The real host picker / workspace lands in Phase 1.
// This proves the IPC boundary end-to-end: it reads ~/.ssh/config on click
// and reports the count, confirming main <-> preload <-> renderer wiring.
import { ref } from 'vue';
import { api } from './ipc';
import type { HostEntry } from '../shared/types';

const hosts = ref<HostEntry[]>([]);
const error = ref<string | null>(null);
const loading = ref(false);

async function loadHosts(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    hosts.value = await api.ssh.listConfigHosts();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="app">
    <header>
      <h1>PocketShell</h1>
      <span class="badge">Phase 0 — foundation</span>
    </header>
    <main>
      <p class="hint">
        Read the hosts from <code>~/.ssh/config</code> to verify the IPC bridge
        is wired correctly. The host picker, session tree, and terminal land in
        Phase 1.
      </p>
      <button :disabled="loading" @click="loadHosts">
        {{ loading ? 'Reading…' : 'Read ~/.ssh/config' }}
      </button>
      <p v-if="error" class="error">{{ error }}</p>
      <ul v-if="hosts.length" class="host-list">
        <li v-for="h in hosts" :key="h.name">
          <strong>{{ h.name }}</strong>
          — {{ h.user || '(default user)' }}@{{ h.hostname }}:{{ h.port }}
          <span v-if="h.identityFile" class="muted">[key]</span>
        </li>
      </ul>
      <p v-else-if="!loading && !error" class="muted">
        No hosts loaded yet. Click the button above.
      </p>
    </main>
  </div>
</template>

<style>
:root {
  --bg: #1e1e2e;
  --fg: #cdd6f4;
  --muted: #7f849c;
  --accent: #89b4fa;
  --error: #f38ba8;
  --border: #313244;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.app {
  padding: 2rem;
  max-width: 900px;
  margin: 0 auto;
}
header {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  border-bottom: 1px solid var(--border);
  padding-bottom: 1rem;
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
.hint {
  color: var(--muted);
  line-height: 1.5;
}
button {
  background: var(--accent);
  color: #1e1e2e;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
.host-list {
  list-style: none;
  padding: 0;
}
.host-list li {
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
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
