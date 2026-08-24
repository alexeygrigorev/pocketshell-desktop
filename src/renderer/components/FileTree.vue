<script setup lang="ts">
// FileTree: the SFTP directory listing for the current path. Click a dir to
// enter it; click a file to open it in the editor. Includes a breadcrumb,
// refresh, and a "new folder/file" affordance wired to the store.
import { computed } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { useFilesStore } from '../stores/files';
import type { DirEntry } from '../../main/sftp/SftpService';

const emit = defineEmits<{ openFile: [path: string] }>();

const connection = useConnectionStore();
const files = useFilesStore();
const connId = computed(() => connection.connectionId);

const breadcrumbs = computed(() => {
  const parts = files.cwd.split('/').filter(Boolean);
  const crumbs: { name: string; path: string }[] = [{ name: '~', path: '/' }];
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    crumbs.push({ name: p, path: acc });
  }
  return crumbs;
});

async function onEntry(entry: DirEntry): Promise<void> {
  if (!connId.value) return;
  if (entry.type === 'dir') {
    await files.cd(connId.value, entry.name);
  } else if (entry.type === 'file' || entry.type === 'symlink') {
    emit('openFile', entry.name);
  }
}

async function onCrumb(path: string): Promise<void> {
  if (!connId.value) return;
  files.cwd = path;
  await files.refresh(connId.value);
}

function fmtSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function icon(entry: DirEntry): string {
  return entry.type === 'dir' ? '📁' : entry.type === 'symlink' ? '↪' : '📄';
}
</script>

<template>
  <div class="file-tree">
    <div class="breadcrumb">
      <span v-for="(c, i) in breadcrumbs" :key="i" class="crumb">
        <a @click="onCrumb(c.path)">{{ c.name }}</a>
        <span v-if="i < breadcrumbs.length - 1" class="sep">/</span>
      </span>
      <button class="icon-btn" :disabled="files.loading" @click="files.refresh(connId!)" title="Refresh">
        {{ files.loading ? '…' : '⟳' }}
      </button>
    </div>
    <ul class="entries">
      <li v-if="files.cwd !== '/'" class="entry" @click="files.cd(connId!, '..')">
        <span class="ic">📁</span><span class="nm muted">..</span>
      </li>
      <li
        v-for="e in files.entries"
        :key="e.name"
        class="entry"
        :class="{ active: files.openPath && files.openPath.endsWith('/' + e.name) }"
        @click="onEntry(e)"
      >
        <span class="ic">{{ icon(e) }}</span>
        <span class="nm" :title="e.name">{{ e.name }}</span>
        <span v-if="e.type === 'file'" class="sz">{{ fmtSize(e.size) }}</span>
      </li>
      <li v-if="!files.entries.length && !files.loading" class="empty muted">empty directory</li>
    </ul>
    <p v-if="files.error" class="error">{{ files.error }}</p>
  </div>
</template>

<style scoped>
.file-tree {
  display: flex;
  flex-direction: column;
  min-width: 260px;
  border-right: 1px solid var(--border);
  background: var(--surface);
  height: 100%;
}
.breadcrumb {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-height: var(--tabbar-h);
  padding: var(--sp-1) var(--sp-3);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-200);
  flex-wrap: wrap;
}
.crumb a {
  cursor: pointer;
  color: var(--accent);
}
.crumb a:hover {
  text-decoration: underline;
}
.sep {
  color: var(--fg-muted);
  margin: 0 2px;
}
.icon-btn {
  margin-left: auto;
  height: var(--control-h-sm);
}
.entries {
  list-style: none;
  margin: 0;
  padding: var(--sp-1) 0;
  flex: 1;
  overflow-y: auto;
}
.entry {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: var(--row-h);
  padding: var(--row-pad-y) var(--row-pad-x);
  cursor: pointer;
  font-size: var(--fs-300);
  line-height: var(--lh-300);
}
.entry:hover {
  background: var(--state-hover);
}
.entry.active {
  background: var(--state-selected);
}
/* DESIGN.md §5.7 asks for a --warning folder glyph and a --fg-muted file
   glyph. `icon()` returns colour emoji (📁/📄), and `color` has no effect on
   colour-emoji rasterisation — so this only reaches the monochrome symlink
   glyph (↪). Tinting the other two needs the emoji replaced first. */
.ic {
  width: 1.1rem;
  flex-shrink: 0;
  text-align: center;
  color: var(--fg-muted);
}
.nm {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}
.sz {
  color: var(--fg-secondary);
  font-size: var(--fs-100);
  text-align: right;
  white-space: nowrap;
}
.empty {
  padding: var(--sp-4) var(--sp-3);
}
.error {
  padding: 0 var(--sp-3) var(--sp-2);
}
</style>
