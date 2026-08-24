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
  padding: var(--sp-4) var(--sp-5);
  overflow-y: auto;
  height: 100%;
}
.panel-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
.toggle,
.add-btn {
  height: var(--control-h);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  padding: 0 var(--sp-3);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
.toggle:hover {
  color: var(--fg);
}
.toggle.on {
  background: var(--accent-soft);
  border-color: var(--accent-dim);
  color: var(--accent);
}
.hint {
  font-size: var(--fs-200);
}
.add-form {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
  flex-wrap: wrap;
  font-size: var(--fs-200);
  color: var(--fg-secondary);
}
.add-form select,
.add-form input {
  height: var(--control-h);
  background: var(--surface-2);
  /* WCAG 1.4.11: controls need a >=3:1 boundary; --border is 1.49:1. */
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  padding: 0 var(--sp-2);
  font-family: var(--font-mono);
  font-size: var(--fs-300);
}
.add-form label {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
}
.add-form input[type='number'] {
  width: 5rem;
}
.add-form input.host {
  width: 9rem;
}
.add-btn {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
  font-weight: var(--fw-semibold);
}
.add-btn:hover {
  background: var(--accent-dim);
  color: var(--fg);
}
.fwd-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-200);
}
.fwd-table th,
.fwd-table td {
  text-align: left;
  padding: var(--sp-1) var(--sp-2);
  border-bottom: 1px solid var(--border-soft);
}
.fwd-table th {
  background: var(--surface-2);
  color: var(--fg-muted);
  font-weight: var(--fw-semibold);
  font-size: var(--fs-100);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.fwd-table td {
  font-family: var(--font-mono);
}
.kind {
  font-size: var(--fs-100);
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
}
.kind.local {
  color: var(--accent);
}
.kind.remote {
  color: var(--warning);
}
.kind.dynamic {
  color: var(--agent);
}
.ok {
  color: var(--success);
}
.warn {
  color: var(--warning);
}
.mono {
  color: var(--fg-secondary);
}
.empty {
  padding: var(--sp-4) var(--sp-2);
}
.error {
  padding-top: var(--sp-2);
}
</style>
