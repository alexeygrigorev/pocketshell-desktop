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

/**
 * `percent_remaining` is nullable in the helper's 0.4.44 shape
 * (parsers.ts:266) and codex and grok both really do emit null. An unknown
 * window must NOT be drawn as an empty meter — a 0%-wide bar reads as "quota
 * exhausted" when the truth is "the provider did not report". So the meter is
 * omitted entirely and the row says so.
 */
function hasPct(p: number | null | undefined): p is number {
  return typeof p === 'number' && Number.isFinite(p);
}
function pctColor(p: number): string {
  if (p > 50) return 'var(--success)';
  if (p > 20) return 'var(--warning)';
  return 'var(--error)';
}
function pctWidth(p: number): string {
  return `${Math.max(0, Math.min(100, p))}%`;
}
function pctText(p: number): string {
  return `${p.toFixed(0)}%`;
}

/**
 * The "why is this provider blocked" line. `block_reason` existed on helper
 * 0.4.8 and is GONE on 0.4.44 (parsers.ts:277-283), so reading only that field
 * leaves a branch that can never render on a current host. Fall back to the
 * pass-through `details.limit_reached` the newer helper does emit.
 */
function blockNote(row: { block_reason?: string | null; details?: Record<string, unknown> }): string | null {
  if (row.block_reason) return row.block_reason;
  const reason = row.details?.['limit_reached'];
  if (typeof reason === 'string' && reason.trim()) return reason;
  return null;
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
          <span class="meter-label">
            short-term
            <span v-if="row.short_term.window" class="window-tag">{{ row.short_term.window }}</span>
          </span>
          <template v-if="hasPct(row.short_term.percent_remaining)">
            <div class="meter">
              <div
                class="meter-fill"
                :style="{
                  width: pctWidth(row.short_term.percent_remaining),
                  background: pctColor(row.short_term.percent_remaining),
                }"
              />
            </div>
            <span class="meter-pct" :style="{ color: pctColor(row.short_term.percent_remaining) }">
              {{ pctText(row.short_term.percent_remaining) }}
            </span>
          </template>
          <span v-else class="meter-unknown muted">not reported</span>
        </div>
        <div v-if="row.short_term.reset_at" class="reset muted">
          resets {{ fmtReset(row.short_term.reset_at) }}
        </div>
        <div class="meter-row">
          <span class="meter-label">
            long-term
            <span v-if="row.long_term.window" class="window-tag">{{ row.long_term.window }}</span>
          </span>
          <template v-if="hasPct(row.long_term.percent_remaining)">
            <div class="meter">
              <div
                class="meter-fill"
                :style="{
                  width: pctWidth(row.long_term.percent_remaining),
                  background: pctColor(row.long_term.percent_remaining),
                }"
              />
            </div>
            <span class="meter-pct" :style="{ color: pctColor(row.long_term.percent_remaining) }">
              {{ pctText(row.long_term.percent_remaining) }}
            </span>
          </template>
          <span v-else class="meter-unknown muted">not reported</span>
        </div>
        <div v-if="row.long_term.reset_at" class="reset muted">
          resets {{ fmtReset(row.long_term.reset_at) }}
        </div>
        <p v-if="blockNote(row)" class="block-reason">{{ blockNote(row) }}</p>
      </div>
      <p v-if="!agents.usage.length" class="muted empty">no usage data — is `pocketshell usage` available on this host?</p>
    </div>
  </div>
</template>

<style scoped>
.window-tag {
  margin-left: var(--sp-1);
  padding: 0 var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  font-size: var(--fs-100);
  font-variant-numeric: tabular-nums;
}
/* No meter at all when the provider reported no percentage — see hasPct(). */
.meter-unknown {
  flex: 1;
  font-size: var(--fs-200);
  font-style: italic;
}
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
  flex: 0 0 auto;
  min-width: 5rem;
  display: flex;
  align-items: center;
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
