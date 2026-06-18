<script setup lang="ts">
// UsageView: per-provider quota dashboard from `pocketshell usage --json`.
// Shows short-term + long-term percent remaining and reset times.
import { computed, onMounted } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { useAgentsStore } from '../stores/agents';

const connection = useConnectionStore();
const agents = useAgentsStore();
const connId = computed(() => connection.connectionId);

onMounted(async () => {
  if (connId.value) await agents.loadUsage(connId.value);
});

function pctColor(p: number | undefined): string {
  if (p === undefined) return 'var(--muted)';
  if (p > 50) return '#a6e3a1';
  if (p > 20) return '#f9e2af';
  return '#f38ba8';
}
function fmtReset(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }) : '—';
}
</script>

<template>
  <div class="usage">
    <div class="usage-bar">
      <h2>Provider usage</h2>
      <button class="icon-btn" @click="agents.loadUsage(connId!)">⟳</button>
    </div>
    <div class="cards">
      <div v-for="row in agents.usage" :key="row.provider" class="card">
        <div class="card-header">
          <span class="provider">{{ row.provider }}</span>
          <span :class="['status', row.status]">{{ row.status }}</span>
        </div>
        <div class="meter-row">
          <span class="meter-label">short-term</span>
          <div class="meter">
            <div
              class="meter-fill"
              :style="{ width: `${row.short_term.percent_remaining}%`, background: pctColor(row.short_term.percent_remaining) }"
            />
          </div>
          <span class="meter-pct" :style="{ color: pctColor(row.short_term.percent_remaining) }">
            {{ row.short_term.percent_remaining.toFixed(0) }}%
          </span>
        </div>
        <div class="reset muted">resets {{ fmtReset(row.short_term.reset_at) }}</div>
        <div class="meter-row">
          <span class="meter-label">long-term</span>
          <div class="meter">
            <div
              class="meter-fill"
              :style="{ width: `${row.long_term.percent_remaining}%`, background: pctColor(row.long_term.percent_remaining) }"
            />
          </div>
          <span class="meter-pct" :style="{ color: pctColor(row.long_term.percent_remaining) }">
            {{ row.long_term.percent_remaining.toFixed(0) }}%
          </span>
        </div>
        <div class="reset muted">resets {{ fmtReset(row.long_term.reset_at) }}</div>
        <p v-if="row.block_reason" class="block-reason">{{ row.block_reason }}</p>
      </div>
      <p v-if="!agents.usage.length" class="muted empty">no usage data — is `pocketshell usage` available on this host?</p>
    </div>
  </div>
</template>

<style scoped>
.usage {
  padding: 1rem 1.5rem;
  overflow-y: auto;
  height: 100%;
}
.usage-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
h2 {
  margin: 0;
  font-size: 1.1rem;
}
.icon-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--fg);
  cursor: pointer;
  padding: 0.2rem 0.5rem;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}
.card {
  background: #181825;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}
.provider {
  font-weight: 600;
  text-transform: capitalize;
}
.status {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.status.ok { color: #a6e3a1; }
.status.limited { color: #f9e2af; }
.status.blocked, .status.error { color: #f38ba8; }
.meter-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.2rem;
}
.meter-label {
  width: 5rem;
  font-size: 0.75rem;
  color: var(--muted);
}
.meter {
  flex: 1;
  height: 8px;
  background: #11111b;
  border-radius: 4px;
  overflow: hidden;
}
.meter-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s;
}
.meter-pct {
  width: 3rem;
  text-align: right;
  font-size: 0.8rem;
  font-family: ui-monospace, monospace;
}
.reset {
  font-size: 0.72rem;
  margin: 0 0 0.5rem 5.5rem;
}
.block-reason {
  color: #f9e2af;
  font-size: 0.8rem;
  margin: 0.5rem 0 0;
}
.muted { color: var(--muted); }
.empty { font-style: italic; }
</style>
