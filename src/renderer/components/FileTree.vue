<script setup lang="ts">
// FileTree: the SFTP directory listing for the current path. Click a dir to
// enter it; click a file to open it in the editor. Includes a breadcrumb,
// refresh, and a "new folder/file" affordance wired to the store.
import { computed } from 'vue';
import AppIcon, { type AppIconName } from './AppIcon.vue';
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

/**
 * The row's icon NAME (docs/POLISH.md §2.5). It doubles as the row icon's CSS
 * class, which is how the three entry types get their three token colours —
 * something the colour emoji this replaced could never do, because emoji
 * rasterisation ignores `color` entirely.
 */
function icon(entry: DirEntry): AppIconName {
  return entry.type === 'dir' ? 'folder' : entry.type === 'symlink' ? 'symlink' : 'file';
}
</script>

<template>
  <div class="file-tree">
    <div class="breadcrumb">
      <span v-for="(c, i) in breadcrumbs" :key="i" class="crumb">
        <a @click="onCrumb(c.path)">{{ c.name }}</a>
        <span v-if="i < breadcrumbs.length - 1" class="sep">/</span>
      </span>
      <button
        class="icon-btn sm"
        :disabled="files.loading"
        title="Refresh"
        @click="files.refresh(connId!)"
      >
        <AppIcon name="refresh" :size="14" :class="{ spin: files.loading }" />
      </button>
    </div>
    <ul class="entries">
      <li v-if="files.cwd !== '/'" class="entry up" @click="files.cd(connId!, '..')">
        <AppIcon name="folder" />
        <span class="nm muted">..</span>
      </li>
      <li
        v-for="e in files.entries"
        :key="e.name"
        class="entry"
        :class="{ active: files.openPath && files.openPath.endsWith('/' + e.name) }"
        @click="onEntry(e)"
      >
        <AppIcon :name="icon(e)" :class="icon(e)" />
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
/* Navigation, not selection: accent is reserved for the selected row (see
   HostPickerView and DESIGN.md §5.2). An all-cyan crumb row made pure
   wayfinding the loudest thing on the Files screen. */
.crumb a {
  cursor: pointer;
  color: var(--fg-secondary);
  transition: color var(--dur-fast) var(--ease);
}
.crumb a:hover {
  color: var(--fg);
  text-decoration: underline;
}
.sep {
  color: var(--fg-muted);
  margin: 0 2px;
}
/* Layout only — the size comes from the shared `.icon-btn.sm` primitive; this
   used to fork it with its own height. */
.icon-btn {
  margin-left: auto;
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
  /* 2px of the left inset is the selection rail's slot, same as
     SessionTree's .session-row, so the two lists mark selection alike. */
  padding: var(--row-pad-y) var(--row-pad-x) var(--row-pad-y) var(--sp-2);
  border-left: 2px solid transparent;
  cursor: pointer;
  font-size: var(--fs-300);
  line-height: var(--lh-300);
}
.entry:hover {
  background: var(--state-hover);
}
.entry.active {
  background: var(--state-selected);
  border-left-color: var(--accent);
}
/* Entry icons (docs/POLISH.md §2.5). The folder carries the most weight so
   the dir/file hierarchy reads at a glance; files sit quietest (decorative —
   the filename beside them carries the information); symlinks sit one step up
   because "this is not a real file" is worth a glance.
   Nothing changes on HOVER by design: icon colour flicker under a sweeping
   cursor reads as smear, and the row's --state-hover fill is the feedback.
   On SELECTED only the file icon lifts, so it does not read disabled against
   the accent fill. The 16px icon box IS the column — the old `.ic` rem width
   was sized for an emoji. */
.entry .app-icon {
  color: var(--fg-muted);
}
.entry .app-icon.folder {
  color: var(--warning);
}
.entry .app-icon.symlink {
  color: var(--fg-secondary);
}
.entry.up .app-icon {
  color: var(--fg-muted);
}
.entry.active .app-icon {
  color: var(--fg-secondary);
}
.entry.active .app-icon.folder {
  color: var(--warning);
}
.entry.active .app-icon.symlink {
  color: var(--fg-secondary);
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
