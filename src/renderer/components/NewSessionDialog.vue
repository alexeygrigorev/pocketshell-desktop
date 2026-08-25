<script setup lang="ts">
// NewSessionDialog: folder-first session creation.
//
// This replaces the bare "new session name" field that used to sit at the
// bottom of SessionTree. That field had the model backwards. A session is not
// named, it is PLACED: the user picks a project folder on the host and the
// session name is DERIVED from it (`~/git/pocketshell` -> `git-pocketshell`)
// by the same rule `tmuxctl` and the Android app use, so all three clients
// agree about which session belongs to which folder. The derived name is shown
// in the footer before anything is committed; it is never typed.
//
// Three routes, one destination:
//
//   existing  browse to a folder that is already there
//   new       create an empty folder under the folder you browsed to
//   clone     clone a GitHub repo (or reuse one already on the host)
//
// All three converge on `projects.startSession(folder)`.
//
// Browsing deliberately goes through the SFTP surface (`projects.home()` for
// the root, `sftp.list()` filtered to directories) rather than a folder
// channel of its own — see src/renderer/stores/projects.ts.
//
// The outcome banner does not auto-dismiss, and that is deliberate. Two of the
// backend's honest answers cannot be read off the session row afterwards:
// `via: 'tmux-fallback'` means the session was created WITHOUT a memory cap,
// and `code: 'folder-missing'` guards a real helper trap where a `-c` at a
// missing directory exits 0 and silently lands the pane in `$HOME`. Both are
// worth a sentence, so the dialog says it and the user presses Open.
import { computed, onMounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import OverlayPanel from './OverlayPanel.vue';
import { useConnectionStore } from '../stores/connection';
import { displayPath, joinPosix, useProjectsStore } from '../stores/projects';
import type { RepoEntry } from '../../main/projects/repos';
import type { StartSessionResult } from '../../main/projects/ProjectsService';

const props = withDefaults(
  defineProps<{
    /**
     * An ABSOLUTE host directory to open the browser AT, instead of `$HOME`.
     *
     * Set by the `+` on a session-panel ROOT row (`git`, `tmp`, …), where the
     * user has already said which root and only the folder under it is still
     * open. Null — the general `+`, and every other caller — keeps the original
     * behaviour: land on `$HOME`, or stay wherever the browser was left.
     *
     * It must be absolute. The browse goes over SFTP, which runs no shell, so a
     * `~` in here would name a literal directory called `~`; the panel resolves
     * its root keys with `rootHostPath` before passing them down and does not
     * open this dialog at all when that resolution fails.
     */
    startIn?: string | null;
  }>(),
  { startIn: null },
);

const emit = defineEmits<{
  /** The session is live on the host; open it. */
  started: [session: string];
  close: [];
}>();

type Route = 'existing' | 'new' | 'clone';

const connection = useConnectionStore();
const projects = useProjectsStore();

const route = ref<Route>('existing');
/** Name for the folder created by the `new` route. */
const newFolderName = ref('');
/** Filter over the merged repo list. */
const repoFilter = ref('');
/** `owner/repo` typed by hand, for a repo `gh` did not list. */
const manualRepo = ref('');
/** Which listed repo is selected, keyed by {@link repoKey}. */
const selectedRepo = ref<string | null>(null);
/** Clone destination root on the host. The helper's own default is `~/git`. */
const cloneRoot = ref('~/git');
/**
 * This dialog ALWAYS asks the host for a genuinely new session, walking
 * `-2`, `-3`… for the name.
 *
 * It used to offer "force a new session even if this folder has one" as an
 * opt-in checkbox, defaulting to reuse, on the reasoning that re-opening a
 * folder's existing session is the idempotent thing and what people want
 * almost every time. That reasoning was about opening a FOLDER. It does not
 * survive the button being called "New session": someone who has pressed that
 * has already said which one they want, and a checkbox asking whether they
 * meant it is a question with one sensible answer.
 *
 * Re-opening an existing session is not lost — it is what selecting the
 * folder in the panel does, and every session in it already has a tab.
 * FolderWorkspaceView's own `+` reached the same conclusion independently
 * (see its `unique` call): once the existing sessions are all on screen,
 * "new" can only mean new.
 */

/** Live preview of the name the host would derive. Never user-entered. */
const derivedName = ref('');
/** Set while a route's own slow step (mkdir, clone) is running. */
const preparing = ref<string | null>(null);
/** Anything that stopped us BEFORE `startSession` ran. */
const stepError = ref<string | null>(null);
/** The host's answer, kept on screen until the user acts on it. */
const outcome = ref<StartSessionResult | null>(null);

const connId = computed(() => connection.connectionId);
const busy = computed(() => preparing.value !== null || projects.starting);

/** Breadcrumb segments for the browsed path, `~` collapsed. */
const crumbs = computed(() => {
  const shown = displayPath(projects.cwd, projects.home);
  const parts = shown.split('/').filter((p) => p.length > 0);
  const out: { label: string; path: string }[] = [];
  let acc = shown.startsWith('~') ? (projects.home ?? '') : '';
  for (const part of parts) {
    if (part === '~') continue;
    acc = joinPosix(acc || '/', part);
    out.push({ label: part, path: acc });
  }
  return out;
});

const filteredRepos = computed(() => {
  const needle = repoFilter.value.trim().toLowerCase();
  const rows = [...projects.repos].sort((a, b) => repoLabel(a).localeCompare(repoLabel(b)));
  if (!needle) return rows;
  return rows.filter((r) => repoLabel(r).toLowerCase().includes(needle));
});

const selectedRepoEntry = computed(
  () => projects.repos.find((r) => repoKey(r) === selectedRepo.value) ?? null,
);

/**
 * The folder the Start button would act on, or null when the route is not
 * ready. For `new` and `clone` this is the folder that WILL exist — it is
 * what the name preview is derived from, and the host re-derives it for real
 * once the folder is on disk.
 */
const targetFolder = computed<string | null>(() => {
  if (route.value === 'existing') return projects.cwd || null;
  if (route.value === 'new') {
    const name = newFolderName.value.trim();
    return name && projects.cwd ? joinPosix(projects.cwd, name) : null;
  }
  const repo = selectedRepoEntry.value;
  if (repo?.local) return repo.local.path;
  const slug = repo ? repoLabel(repo) : manualRepo.value.trim();
  if (!slug) return null;
  const leaf = slug.replace(/\.git$/, '').split('/').filter(Boolean).pop();
  return leaf ? joinPosix(cloneRootAbsolute.value, leaf) : null;
});

/** `~/git` -> `/home/me/git`, so the name preview matches what the host sees. */
const cloneRootAbsolute = computed(() => {
  const root = cloneRoot.value.trim() || '~/git';
  if (root.startsWith('~') && projects.home) return joinPosix(projects.home, root.slice(1));
  return root;
});

/** True when the selected repo is already on the host — no clone needed. */
const alreadyOnHost = computed(() => selectedRepoEntry.value?.local != null);

onMounted(async () => {
  if (!connId.value) return;
  if (props.startIn) {
    // `$HOME` is still resolved, because the name preview and every displayed
    // path are written relative to it — but the browser lands on the ROOT the
    // user pressed `+` on rather than on home, which is the whole point of the
    // prop.
    //
    // `cwd` is cleared FIRST, and that is not tidiness. The browser's cwd lives
    // in the projects STORE, so it survives this dialog closing: without the
    // clear, a browse that fails — a registered root that is not on this host,
    // which is a state the panel renders deliberately — would leave the picker
    // pointed at wherever it was left last time, and `Start session` would
    // cheerfully create a session in a folder the user never chose. Cleared, a
    // failed browse leaves no target at all, the Start button stays dead, and
    // `browseError` says why.
    projects.cwd = '';
    await projects.ensureHome(connId.value);
    await projects.browse(connId.value, props.startIn);
  } else {
    await projects.loadHome(connId.value);
  }
  await projects.loadRepos(connId.value);
});

// The preview is the whole point of the derivation being visible, so it
// re-resolves on every change of target. `deriveName` reads the cached $HOME
// and does no host round-trip of its own.
watch(
  [targetFolder, connId],
  async ([folder, id]) => {
    if (!folder || !id) {
      derivedName.value = '';
      return;
    }
    derivedName.value = await projects.deriveName(id, folder);
  },
  { immediate: true },
);

function repoLabel(repo: RepoEntry): string {
  return repo.fullName ?? repo.name;
}

/** Stable row identity: `fullName` when GitHub knows it, else the path. */
function repoKey(repo: RepoEntry): string {
  return repo.fullName ?? repo.local?.path ?? repo.name;
}

async function onEnter(name: string): Promise<void> {
  if (connId.value) await projects.enter(connId.value, name);
}

async function onUp(): Promise<void> {
  if (connId.value) await projects.up(connId.value);
}

async function onCrumb(path: string): Promise<void> {
  if (connId.value) await projects.browse(connId.value, path);
}

async function onHome(): Promise<void> {
  if (connId.value && projects.home) await projects.browse(connId.value, projects.home);
}

/**
 * The one commit path. Each route resolves a real folder on the host first,
 * then every route ends in the same `startSession` call.
 */
async function onStart(): Promise<void> {
  const id = connId.value;
  if (!id || busy.value) return;
  stepError.value = null;
  outcome.value = null;

  let folder: string | null = null;

  if (route.value === 'existing') {
    folder = projects.cwd || null;
    if (!folder) {
      stepError.value = 'Browse to a folder first.';
      return;
    }
  } else if (route.value === 'new') {
    const name = newFolderName.value.trim();
    if (!name) {
      stepError.value = 'Enter a name for the new folder.';
      return;
    }
    preparing.value = `Creating ${name}…`;
    const made = await projects.createFolder(id, projects.cwd, name);
    preparing.value = null;
    if (!made.ok || !made.path) {
      stepError.value = made.error ?? 'Could not create the folder.';
      return;
    }
    folder = made.path;
  } else {
    const repo = selectedRepoEntry.value;
    if (repo?.local) {
      // Already cloned. Nothing to fetch — go straight on.
      folder = repo.local.path;
    } else {
      const repository = repo ? repoLabel(repo) : manualRepo.value.trim();
      if (!repository) {
        stepError.value = 'Pick a repository, or type an owner/repo.';
        return;
      }
      // Indeterminate on purpose: git's progress meter goes to stderr and the
      // exec buffers to completion, so the host can only say started/finished.
      preparing.value = `Cloning ${repository}…`;
      const cloned = await projects.clone(id, { repository, root: cloneRoot.value.trim() });
      preparing.value = null;
      if (!cloned.ok || !cloned.path) {
        stepError.value = cloneMessage(cloned.error, cloned.state);
        return;
      }
      // `alreadyExists` is NOT a failure: the target was on disk and the host
      // handed us its path. Carry straight on.
      folder = cloned.path;
    }
  }

  const result = await projects.start(
    id,
    folder,
    undefined,
    'unique',
  );
  outcome.value = result;
  if (result.ok) {
    newFolderName.value = '';
    // Land the browser on the folder we just used, so "start another" is
    // already pointed somewhere sensible.
    if (result.folder && route.value !== 'existing') await projects.browse(id, result.folder);
  }
}

/** A clone failure the host classified — say which, not just "git failed". */
function cloneMessage(error: string | null, state?: string): string {
  if (state === 'gh-missing') return 'This host has no GitHub CLI (`gh`), so it cannot clone for you.';
  if (state === 'gh-unauthenticated') return 'The host has `gh` but is not logged in — run `gh auth login` there.';
  if (state === 'helper-missing') return 'This host has no `pocketshell` helper installed.';
  return error ?? 'The clone failed.';
}

function onOpen(): void {
  const name = outcome.value?.sessionName;
  if (name) emit('started', name);
}

function onStartAnother(): void {
  outcome.value = null;
  stepError.value = null;
}
</script>

<template>
  <OverlayPanel title="New session" size="md" @close="emit('close')">
    <div class="new-session">
      <!-- ================= outcome ================= -->
      <section v-if="outcome" class="result">
        <div :class="['result-banner', outcome.ok ? 'ok' : 'bad']">
          <AppIcon :name="outcome.ok ? 'check' : 'alert-triangle'" />
          <div class="result-text">
            <p class="result-title">
              <template v-if="outcome.ok && outcome.reused">
                Re-opened <code>{{ outcome.sessionName }}</code>
              </template>
              <template v-else-if="outcome.ok">
                Started <code>{{ outcome.sessionName }}</code>
              </template>
              <template v-else-if="outcome.code === 'folder-missing'">
                That folder is not on the host
              </template>
              <template v-else>Could not start the session</template>
            </p>
            <p v-if="outcome.ok" class="result-sub muted">
              in <code>{{ displayPath(outcome.folder ?? '', projects.home) }}</code>
              <template v-if="outcome.reused">
                — a session for this folder was already open, so it was reused rather
                than duplicated.
              </template>
            </p>
            <p v-else-if="outcome.code === 'folder-missing'" class="result-sub muted">
              {{ outcome.error }}. Nothing was created — a session started in a missing
              directory would silently land in <code>$HOME</code> instead.
            </p>
            <p v-else class="result-sub muted">{{ outcome.error }}</p>
          </div>
        </div>

        <!-- Said plainly rather than hidden: the raw-tmux path cannot apply the
             helper's systemd memory cap, so this session has no limit on it. -->
        <p v-if="outcome.ok && outcome.via === 'tmux-fallback'" class="fallback-note">
          <AppIcon name="alert-triangle" :size="12" />
          Created with raw <code>tmux</code> — the <code>pocketshell</code> helper was
          not usable here, so this session has <strong>no memory cap</strong>.
        </p>

        <div class="result-actions">
          <button class="btn-secondary" @click="onStartAnother">Start another</button>
          <button v-if="outcome.ok" class="btn-primary" autofocus @click="onOpen">
            Open session
          </button>
        </div>
      </section>

      <!-- ================= picker ================= -->
      <template v-else>
        <nav class="routes" role="tablist">
          <button
            v-for="r in ([
              { id: 'existing', label: 'Existing folder', icon: 'folder' },
              { id: 'new', label: 'New folder', icon: 'folder-plus' },
              { id: 'clone', label: 'Clone from GitHub', icon: 'download' },
            ] as const)"
            :key="r.id"
            class="route"
            :class="{ on: route === r.id }"
            role="tab"
            :aria-selected="route === r.id"
            @click="route = r.id"
          >
            <AppIcon :name="r.icon" :size="14" />
            {{ r.label }}
          </button>
        </nav>

        <!-- ---- routes 1 + 2: the folder browser ---- -->
        <section v-if="route !== 'clone'" class="browser">
          <div class="crumbbar">
            <button class="icon-btn sm" title="Home folder" @click="onHome">
              <AppIcon name="home" :size="14" />
            </button>
            <button
              class="icon-btn sm"
              title="Up one folder"
              :disabled="projects.cwd === '/' || !projects.cwd"
              @click="onUp"
            >
              <AppIcon name="arrow-up" :size="14" />
            </button>
            <span class="crumbs">
              <button class="crumb" @click="onHome">~</button>
              <template v-for="c in crumbs" :key="c.path">
                <span class="crumb-sep">/</span>
                <button class="crumb" @click="onCrumb(c.path)">{{ c.label }}</button>
              </template>
            </span>
          </div>

          <ul class="folder-rows">
            <li
              v-for="d in projects.dirs"
              :key="d.name"
              class="folder-row"
              @click="onEnter(d.name)"
            >
              <AppIcon name="folder" :size="14" class="folder-mark" />
              <span class="folder-name">{{ d.name }}</span>
              <AppIcon name="chevron-right" :size="12" class="into" />
            </li>
            <li v-if="!projects.dirs.length && !projects.browsing" class="empty muted">
              no sub-folders here
            </li>
          </ul>

          <p v-if="projects.browseError" class="error">{{ projects.browseError }}</p>
          <p v-if="projects.homeError" class="error">{{ projects.homeError }}</p>

          <label v-if="route === 'new'" class="field">
            <span class="field-label">New folder name</span>
            <input
              v-model="newFolderName"
              class="text-input"
              placeholder="my-project"
              :disabled="busy"
              @keyup.enter="onStart"
            />
          </label>
        </section>

        <!-- ---- route 3: clone ---- -->
        <section v-else class="repos">
          <!-- A host with no `gh`, or one that is logged out, is a NORMAL
               state: the local clones still list and the panel still works.
               A hint, never a dialog. -->
          <p v-if="projects.remoteUnavailable" class="hint muted">
            <AppIcon name="alert-triangle" :size="12" />
            <template v-if="projects.remoteState === 'gh-missing'">
              This host has no GitHub CLI, so only repos already on disk are listed.
              You can still type an <code>owner/repo</code> below.
            </template>
            <template v-else>
              The host's GitHub CLI is not logged in (<code>gh auth login</code>), so
              only repos already on disk are listed.
            </template>
          </p>
          <p
            v-else-if="projects.remoteState === 'failed' || projects.remoteState === 'helper-missing'"
            class="hint muted"
          >
            <AppIcon name="alert-triangle" :size="12" />
            Could not list GitHub repos{{ projects.remoteError ? `: ${projects.remoteError}` : '' }}.
          </p>

          <div class="filter">
            <AppIcon name="search" :size="14" class="filter-mark" />
            <input
              v-model="repoFilter"
              class="text-input"
              placeholder="filter repositories"
              :disabled="projects.reposLoading"
            />
          </div>

          <ul class="repo-rows">
            <li
              v-for="r in filteredRepos"
              :key="repoKey(r)"
              class="repo-row"
              :class="{ on: selectedRepo === repoKey(r) }"
              @click="selectedRepo = repoKey(r); manualRepo = ''"
            >
              <AppIcon name="git-branch" :size="14" class="repo-mark" />
              <span class="repo-name">{{ repoLabel(r) }}</span>
              <span v-if="r.local" class="tag on-host">on host</span>
              <span v-if="r.local?.head" class="tag">{{ r.local.head }}</span>
              <span v-else-if="r.remote?.defaultBranch" class="tag">
                {{ r.remote.defaultBranch }}
              </span>
            </li>
            <li v-if="!filteredRepos.length && !projects.reposLoading" class="empty muted">
              no repositories listed
            </li>
          </ul>

          <label class="field">
            <span class="field-label">Or clone by name</span>
            <input
              v-model="manualRepo"
              class="text-input"
              placeholder="owner/repo"
              :disabled="busy"
              @input="selectedRepo = null"
            />
          </label>
          <label class="field">
            <span class="field-label">Clone into</span>
            <input v-model="cloneRoot" class="text-input" :disabled="busy || alreadyOnHost" />
          </label>
          <p v-if="alreadyOnHost" class="hint muted">
            Already on the host — this will start a session in the existing clone
            instead of fetching it again.
          </p>
        </section>

        <!-- ---- commit bar ---- -->
        <footer class="commit">
          <div class="preview">
            <span class="preview-label muted">session name</span>
            <code class="preview-name">{{ derivedName || '—' }}</code>
            <span class="preview-label muted">in</span>
            <code class="preview-path" :title="targetFolder ?? ''">
              {{ targetFolder ? displayPath(targetFolder, projects.home) : '—' }}
            </code>
          </div>

          <!-- Indeterminate by construction: the host emits started/finished
               and nothing between them, so a percentage here would be a lie. -->
          <div v-if="preparing" class="progress">
            <span class="progress-label muted">{{ preparing }}</span>
            <span class="progress-track"><span class="progress-bar" /></span>
          </div>

          <p v-if="stepError" class="error">{{ stepError }}</p>

          <div class="commit-actions">
            <button class="btn-secondary" @click="emit('close')">Cancel</button>
            <button
              class="btn-primary"
              :disabled="busy || !targetFolder"
              @click="onStart"
            >
              <AppIcon v-if="busy" name="refresh" :size="14" class="spin" />
              Start session
            </button>
          </div>
        </footer>
      </template>
    </div>
  </OverlayPanel>
</template>

<style scoped>
.new-session {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: var(--sp-3);
  padding: var(--sp-4);
}

/* ---- route selector: one segmented control, VS Code register ---------- */
.routes {
  display: flex;
  gap: var(--sp-1);
  padding: var(--sp-1);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
.route {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  height: var(--control-h);
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.route:hover:not(.on) {
  background: var(--state-hover);
  color: var(--fg);
}
.route.on {
  background: var(--accent-soft);
  color: var(--accent);
}

/* ---- browser --------------------------------------------------------- */
.browser,
.repos {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
}
.crumbbar {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-height: var(--tabbar-h);
}
.crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-200);
}
/* Wayfinding, not selection: accent stays reserved for the selected row
   (DESIGN.md §5.2), same call as FilesView's breadcrumb. */
.crumb {
  background: transparent;
  border: none;
  padding: 0 var(--sp-1);
  color: var(--fg-secondary);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
  border-radius: var(--r-sm);
}
.crumb:hover {
  color: var(--fg);
  background: var(--state-hover);
}
.crumb-sep {
  color: var(--fg-muted);
}

.folder-rows,
.repo-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  /* The list is the only thing allowed to grow: the commit bar must stay
     visible, because the derived name lives in it. */
  flex: 1 1 auto;
  min-height: 140px;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg);
}
.folder-row,
.repo-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: var(--row-h);
  padding: var(--row-pad-y) var(--row-pad-x);
  cursor: pointer;
  border-left: 2px solid transparent;
  font-size: var(--fs-300);
}
.folder-row:hover,
.repo-row:hover {
  background: var(--state-hover);
}
.repo-row.on {
  background: var(--state-selected);
  border-left-color: var(--accent);
}
.folder-mark {
  color: var(--accent);
}
.repo-mark {
  color: var(--fg-muted);
}
.folder-name,
.repo-name {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.into {
  color: var(--fg-muted);
}

/* One badge metric across the app (docs/POLISH.md §7). */
.tag {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex-shrink: 0;
  line-height: var(--lh-100);
  font-size: var(--fs-100);
  color: var(--fg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 0 var(--sp-1);
}
.tag.on-host {
  color: var(--success);
  background: var(--success-soft);
  border-color: transparent;
}

/* ---- fields ---------------------------------------------------------- */
.field {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-200);
}
.field-label {
  flex: 0 0 auto;
  color: var(--fg-secondary);
  min-width: 7.5rem;
}
.text-input {
  flex: 1;
  min-width: 0;
  height: var(--control-h);
  background: var(--surface-2);
  /* WCAG 1.4.11: --border is 1.49:1 and cannot be a control's sole boundary. */
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  padding: 0 var(--sp-2);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-300);
}
.text-input::placeholder {
  color: var(--fg-muted);
  font-family: var(--font-ui);
}
.text-input:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.filter {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.filter-mark {
  color: var(--fg-muted);
}
.hint {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  font-size: var(--fs-200);
  margin: 0;
}
.hint .app-icon {
  margin-top: 3px;
  color: var(--warning);
}

/* ---- commit bar ------------------------------------------------------ */
.commit {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
.preview {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--sp-2);
  font-size: var(--fs-200);
}
.preview-label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: var(--fs-100);
}
.preview-name {
  font-family: var(--font-mono);
  font-size: var(--fs-400);
  font-weight: var(--fw-semibold);
  color: var(--accent);
}
.preview-path {
  font-family: var(--font-mono);
  color: var(--fg-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.commit-actions,
.result-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.btn-primary,
.btn-secondary {
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
  border-radius: var(--r-md);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.btn-primary {
  background: var(--accent);
  color: var(--on-accent);
  border: 1px solid var(--accent);
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-dim);
  color: var(--fg);
}
.btn-primary:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.btn-secondary {
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  color: var(--fg-secondary);
  font-weight: var(--fw-medium);
}
.btn-secondary:hover {
  color: var(--fg);
}

/* Indeterminate: a band that sweeps, with no number attached to it. */
.progress {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.progress-label {
  font-size: var(--fs-200);
}
.progress-track {
  position: relative;
  display: block;
  height: 3px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  overflow: hidden;
}
.progress-bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 35%;
  border-radius: var(--r-sm);
  background: var(--accent);
  animation: sweep 1200ms var(--ease) infinite;
}
@keyframes sweep {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(340%);
  }
}

/* ---- outcome --------------------------------------------------------- */
.result {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.result-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  border: 1px solid var(--border);
}
.result-banner.ok {
  background: var(--success-soft);
  border-color: transparent;
  color: var(--success);
}
.result-banner.bad {
  background: var(--error-soft);
  border-color: transparent;
  color: var(--error);
}
.result-text {
  min-width: 0;
}
.result-title {
  margin: 0;
  font-size: var(--fs-400);
  line-height: var(--lh-400);
  font-weight: var(--fw-semibold);
  color: var(--fg);
}
.result-sub {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-200);
}
.fallback-note {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--warning-soft);
  color: var(--warning);
  font-size: var(--fs-200);
}
.fallback-note .app-icon {
  margin-top: 3px;
}
code {
  font-family: var(--font-mono);
}
</style>
