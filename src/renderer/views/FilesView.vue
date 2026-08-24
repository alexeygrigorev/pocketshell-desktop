<script setup lang="ts">
// FilesView: the SFTP browser. Left = FileTree; right = the open file's
// editor (a capable textarea for v1) or a placeholder. Save writes back
// over SFTP via the files store; Cmd/Ctrl-S and the Save button both work.
//
// NOTE: Monaco is in deps and the architecture is ready for it; the textarea
// is the Phase 2 editor so the build stays simple. Swapping in Monaco is a
// localized change to this view's editor section.
import { computed, onMounted, onBeforeUnmount } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { useFilesStore } from '../stores/files';
import FileTree from '../components/FileTree.vue';

const props = defineProps<{
  /** Directory to open first (e.g. the selected session's cwd). Defaults to home. */
  startPath?: string;
}>();

const connection = useConnectionStore();
const files = useFilesStore();
const connId = computed(() => connection.connectionId);

onMounted(async () => {
  if (connId.value) await files.open(connId.value, props.startPath);
});

onBeforeUnmount(() => {
  files.clear();
});

async function onOpenFile(name: string): Promise<void> {
  if (!connId.value) return;
  await files.openFile(connId.value, name);
}

async function onSave(): Promise<void> {
  if (!connId.value) return;
  await files.save(connId.value);
}

function onKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (files.dirty) void onSave();
  }
}
</script>

<template>
  <div class="files-view" @keydown="onKeydown">
    <FileTree @open-file="onOpenFile" />
    <div class="editor-area">
      <template v-if="files.openPath">
        <div class="editor-bar">
          <span class="path">{{ files.openPath }}</span>
          <span v-if="files.dirty" class="dirty">● unsaved</span>
          <button
            class="save-btn"
            :disabled="!files.dirty || files.saving"
            @click="onSave"
          >
            {{ files.saving ? 'Saving…' : 'Save (⌘S)' }}
          </button>
        </div>
        <textarea
          class="editor"
          :value="files.openContent"
          @input="files.setContent(($event.target as HTMLTextAreaElement).value)"
          spellcheck="false"
        />
      </template>
      <div v-else class="placeholder">
        <p class="muted">select a file to edit</p>
        <p class="muted small">changes save back over SFTP</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* `flex: 1` because the parent `.tab-body` is a flex row — see ConversationView. */
.files-view {
  display: flex;
  flex: 1;
  min-width: 0;
  height: 100%;
}
.editor-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.editor-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  height: var(--tabbar-h);
  flex: 0 0 auto;
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  font-size: var(--fs-200);
}
.path {
  font-family: var(--font-mono);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dirty {
  color: var(--warning);
  font-size: var(--fs-100);
}
.save-btn {
  height: var(--control-h-sm);
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  border-radius: var(--r-md);
  padding: 0 var(--sp-3);
  font-family: var(--font-ui);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  font-size: var(--fs-200);
  transition: background var(--dur-fast) var(--ease);
}
.save-btn:hover:not(:disabled) {
  background: var(--accent-dim);
  color: var(--fg);
}
.save-btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* Deliberately the terminal's own background: an open file and the shell it
   came from should read as the same surface. */
.editor {
  flex: 1;
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: var(--term-bg);
  color: var(--term-fg);
  font-family: var(--font-mono);
  font-size: var(--fs-300);
  line-height: 1.5;
  padding: var(--sp-3) var(--sp-4);
  tab-size: 2;
}
.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-1);
}
.small {
  font-size: var(--fs-200);
  color: var(--fg-muted);
}
</style>
