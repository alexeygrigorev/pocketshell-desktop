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
  height: 100%;
}
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
  font-size: 0.85rem;
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
  color: var(--muted);
  margin: 0 0.15rem;
}
.icon-btn {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--fg);
  cursor: pointer;
  padding: 0.1rem 0.5rem;
}
.icon-btn:disabled {
  opacity: 0.5;
}
.entries {
  list-style: none;
  margin: 0;
  padding: 0.25rem 0;
  flex: 1;
  overflow-y: auto;
}
.entry {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.75rem;
  cursor: pointer;
  font-size: 0.88rem;
}
.entry:hover {
  background: rgba(137, 180, 250, 0.08);
}
.entry.active {
  background: rgba(137, 180, 250, 0.16);
}
.ic {
  width: 1.1rem;
  text-align: center;
}
.nm {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
}
.sz {
  color: var(--muted);
  font-size: 0.75rem;
}
.empty {
  padding: 1rem 0.75rem;
  font-style: italic;
}
.muted {
  color: var(--muted);
}
.error {
  color: var(--error);
  padding: 0 0.75rem;
  font-size: 0.8rem;
}
</style>
