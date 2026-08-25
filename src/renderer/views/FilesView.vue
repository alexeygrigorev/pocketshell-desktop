<script setup lang="ts">
// FilesView: the SFTP browser. Left = FileTree; right = whatever the selected
// file actually is.
//
// That right-hand side used to be a textarea and nothing else, which is what
// froze the app on an mp3: every click decoded the whole file as UTF-8 and
// asked a textarea to lay it out. It is now one of five terminal states, and
// which one is chosen is decided in the store before any bytes move (see
// stores/files.ts and fileKind.ts). The only one that can hold text is the
// editor, and nothing falls back INTO it — a file we cannot render ends in
// the binary panel with a reason and a download button, never in mojibake.
//
// The editor is CodeEditor.vue (CodeMirror 6). Monaco was rejected on a
// measurement rather than a preference: the packaged renderer runs from a
// file:// document whose CSP refuses a blob: worker (`script-src 'self'`, and
// `worker-src` falls back to it), which is exactly what Monaco's language
// services need — the dev-works/packaged-dies failure. See the header of
// components/CodeEditor.vue for the probe output.
import { computed, defineAsyncComponent, onMounted, watch } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { useFilesStore, formatBytes } from '../stores/files';
import FileTree from '../components/FileTree.vue';

/**
 * Loaded on demand. CodeMirror is ~680 KB of the renderer, and a workspace
 * that never opens a text file must not pay for it at startup: imported
 * eagerly the entry chunk grows by 684 KB, asynchronously by 7 KB — and the
 * editor arrives with the first file that needs it. Each grammar is a further
 * chunk of its own, fetched only for the language actually opened.
 */
const CodeEditor = defineAsyncComponent(() => import('../components/CodeEditor.vue'));

const props = defineProps<{
  /** Directory to open first (e.g. the selected session's cwd). Defaults to home. */
  startPath?: string;
  /**
   * Identity of the session this tab belongs to, so the browsed directory is
   * remembered per session. Optional: when the parent has no name to give,
   * the start directory identifies the session well enough — two sessions
   * rooted in the same folder sharing a browsing position is not a bug.
   */
  sessionKey?: string;
}>();

const connection = useConnectionStore();
const files = useFilesStore();
const connId = computed(() => connection.connectionId);

onMounted(async () => {
  if (connId.value) await files.open(connId.value, props.startPath, props.sessionKey);
});

// The session's working directory can arrive AFTER this view mounts — the
// sessions store is refreshed lazily, so a workspace opened by deep link (or
// straight after creating a session) renders with `startPath` undefined and
// only learns the real directory a moment later. Without this watch the tab
// stays wherever it landed, which is the login home, and looks for all the
// world like the session really is in `~`. Re-opening is safe because the
// store prefers a remembered position, so a user who has already navigated
// somewhere is not yanked back.
watch(
  () => props.startPath,
  async (next, prev) => {
    if (!connId.value || next === prev || !next) return;
    await files.open(connId.value, next, props.sessionKey);
  },
);

// Deliberately NO `files.clear()` on unmount. The Files tab lives behind a
// `v-if`, so switching to Terminal unmounts it — and clearing here is what
// made the user lose their place every time they looked at the terminal. The
// guarantee `clear()` exists for (one connection's listing must never be
// shown for another) is kept by clearing on DISCONNECT instead.

async function onOpenFile(name: string): Promise<void> {
  if (!connId.value) return;
  await files.openFile(connId.value, name);
}

async function onSave(): Promise<void> {
  if (!connId.value) return;
  await files.save(connId.value);
}

async function onDownload(): Promise<void> {
  if (!connId.value) return;
  await files.download(connId.value);
}

function onKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (files.dirty) void onSave();
  }
}

/** Basename of the open file, for the viewer headings. */
const openName = computed(() => files.openPath?.split('/').pop() ?? '');
const sizeLabel = computed(() => (files.openSize > 0 ? formatBytes(files.openSize) : ''));
</script>

<template>
  <div class="files-view" @keydown="onKeydown">
    <FileTree @open-file="onOpenFile" />
    <div class="editor-area">
      <template v-if="files.openPath">
        <div class="editor-bar">
          <span class="path">{{ files.openPath }}</span>
          <span v-if="files.dirty" class="dirty">
            <span class="dirty-dot" />
            unsaved
          </span>
          <!-- The handler is `metaKey || ctrlKey`; the label used to read
               `Save (⌘S)` — a macOS glyph on a Windows-first app. The chord
               belongs in the tooltip, in this app's Ctrl+... convention. -->
          <button
            v-if="files.openMode === 'text'"
            class="save-btn"
            :disabled="!files.dirty || files.saving"
            title="Ctrl+S"
            @click="onSave"
          >
            {{ files.saving ? 'Saving…' : 'Save' }}
          </button>
          <button class="close-btn" title="Close file" @click="files.closeFile()">Close</button>
        </div>

        <p v-if="files.opening" class="loading muted">opening {{ openName }}…</p>

        <!-- `:model-value` + `@update:model-value`, NOT `v-model`: v-model
             would assign straight to the store ref and skip `setContent`,
             which is the only thing that raises the dirty flag. That is the
             same trap the textarea avoided by binding `:value` rather than
             two-way. -->
        <CodeEditor
          v-else-if="files.openMode === 'text'"
          :model-value="files.openContent"
          :filename="files.openPath"
          @update:model-value="files.setContent"
        />

        <!-- Audio: a real player, not a description of one. The blob URL is
             minted in the store and revoked when the file closes, so the
             element never outlives its bytes. -->
        <div v-else-if="files.openMode === 'audio'" class="viewer audio-viewer">
          <div class="media-head">
            <span class="media-name">{{ openName }}</span>
            <span class="media-meta muted">{{ files.openMime }} · {{ sizeLabel }}</span>
          </div>
          <audio v-if="files.openUrl" class="audio" controls :src="files.openUrl" />
        </div>

        <!-- PDF: Chromium's own viewer. `<embed>` rather than `<iframe>`
             because the PDF plugin is what is being asked for, and object-src
             is the directive that governs it. Requires `plugins: true` on the
             BrowserWindow — see src/main/index.ts. -->
        <div v-else-if="files.openMode === 'pdf'" class="viewer pdf-viewer">
          <embed
            v-if="files.openUrl"
            class="pdf"
            type="application/pdf"
            :src="files.openUrl"
          />
        </div>

        <div v-else-if="files.openMode === 'image'" class="viewer image-viewer">
          <img v-if="files.openUrl" class="image" :src="files.openUrl" :alt="openName" />
        </div>

        <!-- The single honest terminus. Everything that is not text and
             cannot be rendered lands here, with its type, its size and the
             reason — and an offer to take it somewhere that can open it. -->
        <div v-else class="viewer binary-panel">
          <p class="binary-title">{{ openName }}</p>
          <p class="muted">
            {{ files.openNote ?? 'This is a binary file.' }}
          </p>
          <p class="muted small">
            {{ files.openMime ?? 'unknown type' }}<template v-if="sizeLabel"> · {{ sizeLabel }}</template>
          </p>
          <button class="save-btn" @click="onDownload">Download…</button>
        </div>
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
/* A status pip, not an icon: it should stop scaling with font metrics, so it
   is a CSS circle rather than a bullet character. */
.dirty {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--warning);
  font-size: var(--fs-100);
}
.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
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
/* Quiet next to Save: closing is never the action being encouraged. */
.close-btn {
  height: var(--control-h-sm);
  background: transparent;
  color: var(--fg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 0 var(--sp-3);
  font-family: var(--font-ui);
  cursor: pointer;
  font-size: var(--fs-200);
}
.close-btn:hover {
  color: var(--fg);
  background: var(--state-hover);
}
.loading {
  padding: var(--sp-4);
}
.viewer {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--term-bg);
}
.audio-viewer {
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  padding: var(--sp-5);
}
.media-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  font-family: var(--font-mono);
  font-size: var(--fs-300);
  text-align: center;
}
.media-meta {
  font-size: var(--fs-100);
}
.audio {
  width: min(480px, 100%);
}
/* The PDF plugin fills the pane; it brings its own chrome and scrolling. */
.pdf {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: none;
}
.image-viewer {
  align-items: center;
  justify-content: center;
  padding: var(--sp-4);
  overflow: auto;
}
.image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.binary-panel {
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-5);
  text-align: center;
}
.binary-title {
  font-family: var(--font-mono);
  font-size: var(--fs-300);
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
