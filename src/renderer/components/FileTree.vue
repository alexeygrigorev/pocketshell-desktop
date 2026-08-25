<script setup lang="ts">
// FileTree: the SFTP directory listing for the current path. Click a dir to
// enter it; click a file to open it in the editor. Includes a breadcrumb,
// refresh, and a "new folder/file" affordance wired to the store.
import { computed, nextTick, ref } from 'vue';
import AppIcon, { type AppIconName } from './AppIcon.vue';
import { useConnectionStore } from '../stores/connection';
import { useFilesStore, formatBytes, normaliseTypedPath } from '../stores/files';
import type { DirEntry } from '../../main/sftp/SftpService';

const emit = defineEmits<{ openFile: [path: string] }>();

const connection = useConnectionStore();
const files = useFilesStore();
const connId = computed(() => connection.connectionId);

/**
 * The path as clickable segments.
 *
 * This used to unconditionally prepend a `~` crumb pointing at `/` and then
 * list the absolute components after it, so sitting in the login home
 * rendered as `~ / home / alexey` — the same location, said twice, with the
 * first copy linking somewhere else entirely. A `~` is only meaningful if it
 * REPLACES the home prefix, so that is what it does now: when the cwd is
 * inside the login home the home part collapses into a single `~` crumb and
 * only the segments below it are listed; anywhere else the root crumb is `/`,
 * which is what it actually is.
 *
 * `files.home` is resolved lazily and may be empty for the first render or on
 * a host where the resolve failed. That case falls through to the absolute
 * form, which is correct — just longer.
 */
const breadcrumbs = computed(() => {
  const cwd = files.cwd;
  const home = files.home;
  const inHome = home !== '' && (cwd === home || cwd.startsWith(home + '/'));
  const root = inHome ? { name: '~', path: home } : { name: '/', path: '/' };
  const rest = inHome ? cwd.slice(home.length) : cwd;

  const crumbs: { name: string; path: string }[] = [root];
  let acc = inHome ? home : '';
  for (const p of rest.split('/').filter(Boolean)) {
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
  // `goTo` rather than setting `cwd` and refreshing by hand, so a breadcrumb
  // jump is remembered as this session's position like any other move.
  await files.goTo(connId.value, path);
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

// ---------------------------------------------------------------------------
// The path bar
// ---------------------------------------------------------------------------
//
// Typing or pasting a path was the one way to navigate this tab that did not
// exist: the tree walks one directory at a time and the breadcrumb only goes
// UP, so a path sitting in the clipboard — out of terminal output, a log, a
// colleague's message — could not be used at all.
//
// It is click-to-edit rather than a second permanent row, the way Explorer and
// VS Code do it. The breadcrumb strip already IS the "where am I" line, and
// spending another --tabbar-h on a control used a few times a session, in a
// pane whose whole job is a list, is not a trade this layout can afford (see
// the same reasoning behind the merged session bar, DESIGN.md §5.4). The pencil
// button is the affordance, so the feature does not depend on knowing a chord;
// Ctrl+L is there for people who expect it from every address bar they use.
//
// Editing REPLACES the crumbs rather than sitting beside them, which also keeps
// c9d4039's `~` collapsing intact by not touching the crumb builder at all.

/** True while the strip is an input rather than a row of crumbs. */
const editing = ref(false);
/** What the user has typed. Seeded from the current directory on open. */
const draft = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

async function startEditing(): Promise<void> {
  // Seeded with the current directory and fully selected: typing replaces it
  // outright, while a small edit to where you already are stays cheap.
  draft.value = files.cwd;
  editing.value = true;
  await nextTick();
  inputEl.value?.focus();
  inputEl.value?.select();
}

function cancelEditing(): void {
  editing.value = false;
}

/**
 * Go where the field says.
 *
 * The destination goes through `files.revealPath` — the SAME action a path
 * clicked in the terminal uses. That is deliberate and is the point of routing
 * both here: a directory navigates, a file opens in whichever viewer its kind
 * calls for, and a path that is not there says so. Two entry points with two
 * copies of that logic would drift the first time one of them was touched.
 *
 * The field stays open when the path did not resolve, because the next thing
 * the user wants is to fix the typo, not to type the whole path again.
 */
async function onSubmit(): Promise<void> {
  if (!connId.value) return;
  const target = normaliseTypedPath(draft.value, files.cwd);
  if (target == null) {
    editing.value = false;
    return;
  }
  await files.revealPath(connId.value, target);
  if (files.error == null) editing.value = false;
}

/** Lets FilesView put the caret here from its Ctrl+L handler. */
defineExpose({ editPath: startEditing });
</script>

<template>
  <div class="file-tree">
    <div class="breadcrumb">
      <!-- Enter goes, Escape gives up, and blur gives up too: leaving the pane
           with a half-typed path should not commit it. -->
      <input
        v-if="editing"
        ref="inputEl"
        v-model="draft"
        class="path-input"
        spellcheck="false"
        autocomplete="off"
        placeholder="/path/to/file"
        aria-label="Go to path"
        @keydown.enter.prevent="onSubmit"
        @keydown.esc.stop.prevent="cancelEditing"
        @blur="cancelEditing"
      />
      <template v-else>
        <span v-for="(c, i) in breadcrumbs" :key="i" class="crumb">
          <a @click="onCrumb(c.path)">{{ c.name }}</a>
          <span v-if="i < breadcrumbs.length - 1" class="sep">/</span>
        </span>
        <button class="icon-btn sm" title="Go to path (Ctrl+L)" @click="startEditing">
          <AppIcon name="edit-2" :size="14" />
        </button>
      </template>
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
        <span v-if="e.type === 'file'" class="sz">{{ formatBytes(e.size) }}</span>
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
   used to fork it with its own height. The `auto` belongs to the FIRST trailing
   button only: with both claiming it the free space would be split between
   them and the pair would drift apart across the strip. */
.icon-btn {
  margin-left: auto;
}
.icon-btn + .icon-btn {
  margin-left: 0;
}
/* Takes the strip's whole width while it is open — it replaces the crumbs
   rather than sharing the row with them. */
.path-input {
  flex: 1 1 auto;
  min-width: 0;
  height: var(--control-h-sm);
  background: var(--surface-2);
  /* WCAG 1.4.11: a control needs a >=3:1 boundary; --border is 1.49:1. */
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  padding: 0 var(--sp-2);
  font-family: var(--font-mono);
  font-size: var(--fs-200);
}
.path-input::placeholder {
  color: var(--fg-muted);
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
