<script setup lang="ts">
// UsageView: per-provider quota dashboard from `pocketshell usage --json`.
// Shows short-term + long-term percent remaining and reset times.
import { computed, onMounted } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { useAgentsStore } from '../stores/agents';

const props = defineProps<{
  /**
   * True when hosted inside OverlayPanel, which supplies the title itself.
   * Without this the name renders twice — see docs/DESIGN.md §5.5 and
   * docs/screenshots/07-usage-overlay.png.
   */
  embedded?: boolean;
}>();

const connection = useConnectionStore();
const agents = useAgentsStore();
const connId = computed(() => connection.connectionId);

onMounted(async () => {
  if (connId.value) await agents.loadUsage(connId.value);
});

function pctColor(p: number | undefined): string {
  if (p === undefined) return 'var(--fg-muted)';
  if (p > 50) return 'var(--success)';
  if (p > 20) return 'var(--warning)';
  return 'var(--error)';
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
      <h2 v-if="!props.embedded">Provider usage</h2>
      <button class="icon-btn" title="Refresh" @click="agents.loadUsage(connId!)">⟳</button>
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
  padding: var(--sp-4) var(--sp-5);
  overflow-y: auto;
  height: 100%;
}
.usage-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
h2 {
  margin: 0;
  font-size: var(--fs-500);
  line-height: var(--lh-500);
  font-weight: var(--fw-semibold);
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--sp-4);
}
.card {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: var(--sp-4);
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--sp-3);
}
.provider {
  font-size: var(--fs-400);
  line-height: var(--lh-400);
  font-weight: var(--fw-semibold);
  text-transform: capitalize;
}
.status {
  font-size: var(--fs-100);
  line-height: var(--lh-100);
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  border: 1px solid transparent;
}
.status.ok {
  color: var(--success);
  background: var(--success-soft);
}
.status.limited {
  color: var(--warning);
  background: var(--warning-soft);
}
.status.blocked,
.status.error {
  color: var(--error);
  background: var(--error-soft);
}
.meter-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-1);
}
.meter-label {
  width: 5rem;
  font-size: var(--fs-100);
  color: var(--fg-secondary);
}
.meter {
  flex: 1;
  height: 6px;
  background: var(--surface-3);
  border-radius: var(--r-sm);
  overflow: hidden;
}
.meter-fill {
  height: 100%;
  border-radius: var(--r-sm);
  transition: width var(--dur-normal) var(--ease);
}
.meter-pct {
  width: 3rem;
  text-align: right;
  font-size: var(--fs-200);
  font-family: var(--font-mono);
}
.reset {
  font-size: var(--fs-100);
  margin: 0 0 var(--sp-2) 5.5rem;
}
.block-reason {
  color: var(--warning);
  font-size: var(--fs-200);
  margin: var(--sp-2) 0 0;
}
.empty {
  grid-column: 1 / -1;
}
</style>
