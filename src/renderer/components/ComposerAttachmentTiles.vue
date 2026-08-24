<script setup lang="ts">
// ComposerAttachmentTiles: the pending list of staged attachments.
//
// These are STRUCTURED STATE, never folded into the draft while composing —
// their remote paths are appended to the text at send time and only then
// (docs/COMPOSER.md §5.1, §6). That is why attaching a file does not make the
// textarea jump, and why removing a tile leaves the draft untouched.
//
// Each tile shows the file NAME only, never the full remote path
// (PromptComposerViewModel.kt:2675).
import ComposerIcon from './ComposerIcon.vue';
import type { StagedAttachment } from '../stores/composer';

defineProps<{
  attachments: StagedAttachment[];
  /** Removal is disabled while a send is in flight. */
  disabled?: boolean;
}>();

const emit = defineEmits<{ (e: 'remove', remotePath: string): void }>();
</script>

<template>
  <ul class="tiles" aria-label="Staged attachments">
    <li v-for="a in attachments" :key="a.remotePath" class="tile" :title="a.remotePath">
      <img v-if="a.previewDataUrl" class="thumb" :src="a.previewDataUrl" alt="" />
      <ComposerIcon v-else class="glyph" name="file" />
      <span class="name">{{ a.displayName }}</span>
      <button
        class="remove"
        type="button"
        :disabled="disabled"
        :title="`Remove ${a.displayName}`"
        :aria-label="`Remove ${a.displayName}`"
        @click="emit('remove', a.remotePath)"
      >
        <ComposerIcon name="close" />
      </button>
    </li>
  </ul>
</template>

<style scoped>
.tiles {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  list-style: none;
  margin: 0;
  padding: 0;
}
.tile {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  max-width: 220px;
  height: var(--control-h);
  padding: 0 var(--sp-1) 0 var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-size: var(--fs-200);
  color: var(--fg);
}
.thumb {
  width: 18px;
  height: 18px;
  object-fit: cover;
  border-radius: 2px;
  flex: 0 0 auto;
}
.glyph {
  width: 14px;
  height: 14px;
  color: var(--fg-secondary);
}
.name {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.remove {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  font-size: var(--fs-100);
  cursor: pointer;
}
.remove :deep(.icon) {
  width: 11px;
  height: 11px;
}
.remove:hover:not(:disabled) {
  background: var(--state-active);
  color: var(--fg);
}
.remove:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
</style>
