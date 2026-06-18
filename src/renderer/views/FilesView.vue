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

const connection = useConnectionStore();
const files = useFilesStore();
const connId = computed(() => connection.connectionId);

onMounted(async () => {
  if (connId.value) await files.open(connId.value);
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
.files-view {
  display: flex;
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
  gap: 0.75rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: #181825;
  font-size: 0.85rem;
}
.path {
  font-family: ui-monospace, monospace;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dirty {
  color: #f9e2af;
  font-size: 0.75rem;
}
.save-btn {
  background: var(--accent);
  color: #1e1e2e;
  border: none;
  border-radius: 6px;
  padding: 0.25rem 0.75rem;
  font-weight: 600;
  cursor: pointer;
  font-size: 0.8rem;
}
.save-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.editor {
  flex: 1;
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: #1e1e2e;
  color: #cdd6f4;
  font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
  font-size: 13px;
  line-height: 1.5;
  padding: 0.75rem 1rem;
  tab-size: 2;
}
.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 0.8rem;
}
</style>
