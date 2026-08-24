<script setup lang="ts">
// OverlayPanel: a modal sheet for host-level panels (Ports, Usage) that are
// reachable from the host header but are not peer tabs of the session tabs.
// Closes on backdrop click and on Escape; the content is supplied by the
// default slot so the panels themselves stay plain views.
import { onBeforeUnmount, onMounted } from 'vue';

defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="overlay-backdrop" @click.self="emit('close')">
    <div class="overlay-panel" role="dialog" aria-modal="true" :aria-label="title">
      <header class="overlay-header">
        <h2 class="overlay-title">{{ title }}</h2>
        <button class="icon-btn" @click="emit('close')" title="Close">✕</button>
      </header>
      <div class="overlay-body">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}
.overlay-panel {
  display: flex;
  flex-direction: column;
  width: min(960px, 92vw);
  height: min(720px, 88vh);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.overlay-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
}
.overlay-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}
.overlay-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: auto;
}
.overlay-body > :deep(*) {
  flex: 1;
  min-width: 0;
}
.icon-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  padding: 0.2rem 0.6rem;
  cursor: pointer;
  font-size: 0.85rem;
}
</style>
