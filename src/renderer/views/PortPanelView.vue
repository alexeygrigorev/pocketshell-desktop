<script setup lang="ts">
// PortPanelView: the port-forward table. Shows the remote port scan, the live
// forwards (auto + manual), and lets the user toggle auto-forward, add a
// manual -L/-R/-D, or remove one.
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { useForwardsStore } from '../stores/forwards';
import type { ForwardSpec } from '../../shared/types';
import type { ForwardState } from '../../main/portfwd/Forwarder';

const connection = useConnectionStore();
const forwards = useForwardsStore();
const connId = computed(() => connection.connectionId);

// Manual-add form
const kind = ref<ForwardSpec['kind']>('local');
const localPort = ref<number>(8080);
const remotePort = ref<number>(8080);
const remoteHost = ref('127.0.0.1');

onMounted(async () => {
  if (connId.value) {
    forwards.subscribe(connId.value);
    await forwards.scan(connId.value);
  }
});

onBeforeUnmount(() => {
  forwards.clear();
});

async function onAdd(): Promise<void> {
  if (!connId.value) return;
  const spec: ForwardSpec =
    kind.value === 'dynamic'
      ? { kind: 'dynamic', listenHost: '127.0.0.1', listenPort: localPort.value, destHost: '', destPort: 0 }
      : {
          kind: kind.value,
          listenHost: '127.0.0.1',
          listenPort: localPort.value,
          destHost: remoteHost.value,
          destPort: remotePort.value,
        };
  await forwards.addManual(connId.value, spec);
}

function keyOf(s: ForwardState): string {
  return `${s.kind}:${s.listenPort}->${s.destHost}:${s.destPort}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <div class="port-panel">
    <div class="panel-bar">
      <button class="icon-btn" :disabled="forwards.loading" @click="forwards.scan(connId!)">
        {{ forwards.loading ? '…' : '⟳ Scan' }}
      </button>
      <button
        :class="['toggle', { on: forwards.autoOn }]"
        @click="forwards.toggleAuto(connId!)"
      >
        Auto-forward: {{ forwards.autoOn ? 'ON' : 'OFF' }}
      </button>
      <span class="muted hint">auto mirrors remote ports 1024–10000 to localhost</span>
    </div>

    <section class="add-form">
      <select v-model="kind">
        <option value="local">-L local</option>
        <option value="remote">-R remote</option>
        <option value="dynamic">-D SOCKS</option>
      </select>
      <label>local <input v-model.number="localPort" type="number" /></label>
      <template v-if="kind !== 'dynamic'">
        <label>→ <input v-model="remoteHost" class="host" /></label>
        <label>: <input v-model.number="remotePort" type="number" /></label>
      </template>
      <button class="add-btn" @click="onAdd">Add</button>
    </section>

    <table class="fwd-table">
      <thead>
        <tr><th>Kind</th><th>Local</th><th>Remote</th><th>Status</th><th>In</th><th>Out</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="s in forwards.states" :key="keyOf(s)">
          <td><span :class="['kind', s.kind]">{{ s.kind }}</span></td>
          <td>{{ s.listenHost }}:{{ s.listenPort }}</td>
          <td>{{ s.kind === 'dynamic' ? 'SOCKS' : `${s.destHost}:${s.destPort}` }}</td>
          <td :class="s.active ? 'ok' : 'warn'">{{ s.active ? 'forwarding' : 'idle' }}</td>
          <td class="mono">{{ fmtBytes(s.bytesIn) }}</td>
          <td class="mono">{{ fmtBytes(s.bytesOut) }}</td>
          <td><button class="icon-btn" @click="forwards.remove(connId!, keyOf(s))">✕</button></td>
        </tr>
        <tr v-if="!forwards.states.length">
          <td colspan="7" class="muted empty">no forwards — add one above or enable auto-forward</td>
        </tr>
      </tbody>
    </table>

    <p v-if="forwards.error" class="error">{{ forwards.error }}</p>
  </div>
</template>

<style scoped>
.port-panel {
  padding: 1rem 1.5rem;
  overflow-y: auto;
  height: 100%;
}
.panel-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.icon-btn, .toggle, .add-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  padding: 0.3rem 0.75rem;
  cursor: pointer;
  font-size: 0.85rem;
}
.toggle.on {
  background: rgba(166, 227, 161, 0.15);
  border-color: #a6e3a1;
  color: #a6e3a1;
}
.hint {
  font-size: 0.78rem;
}
.add-form {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.add-form select, .add-form input {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--fg);
  padding: 0.25rem 0.4rem;
  font-size: 0.85rem;
}
.add-form input[type="number"] {
  width: 5rem;
}
.add-form input.host {
  width: 9rem;
}
.add-btn {
  background: var(--accent);
  color: #1e1e2e;
  border: none;
  font-weight: 600;
}
.fwd-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.fwd-table th, .fwd-table td {
  text-align: left;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--border);
}
.fwd-table th {
  color: var(--muted);
  font-weight: 500;
  font-size: 0.75rem;
  text-transform: uppercase;
}
.kind {
  font-size: 0.72rem;
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.kind.local { color: #89b4fa; }
.kind.remote { color: #f9e2af; }
.kind.dynamic { color: #cba6f7; }
.ok { color: #a6e3a1; }
.warn { color: #f9e2af; }
.mono { font-family: ui-monospace, monospace; font-size: 0.8rem; color: var(--muted); }
.muted { color: var(--muted); }
.empty { font-style: italic; }
.error { color: var(--error); }
</style>
