import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId } from '../../shared/types';
import type { DirEntry } from '../../main/sftp/SftpService';

/**
 * Files store: the SFTP browser state for the active connection. Holds the
 * current directory listing + the open file buffer. Tree expansion is local
 * UI state; this store only owns the fetched data + editing buffer.
 */
export const useFilesStore = defineStore('files', () => {
  const cwd = ref<string>('');
  const entries = ref<DirEntry[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** The currently-open file: path + content + dirty flag. */
  const openPath = ref<string | null>(null);
  const openContent = ref<string>('');
  const dirty = ref(false);
  const saving = ref(false);

  async function open(connectionId: ConnectionId, startPath?: string): Promise<void> {
    // Default to the login home; sftp realPath('.') resolves it. Callers with
    // a better starting point (e.g. a session's working directory) pass one.
    //
    // The resolve runs INSIDE the guard, and that is the whole point of this
    // shape. `startPath` is a session's cwd as tmux reported it, which is not
    // guaranteed to be a path SFTP can resolve: helper/parsers.ts notes that
    // `session_path` "can even be a literal unexpanded `~/git`", and an SFTP
    // channel has no tilde expansion (the same fact AttachmentStager resolves
    // `realpath(".")` for). A rejection here used to escape `open` entirely,
    // which left `cwd` empty — and `refresh` early-returns on an empty cwd,
    // so nothing ever set `error`. The pane rendered zero entries and no
    // message: a silently empty Files tab that reads as an empty home
    // directory rather than as the failure it is.
    error.value = null;
    let note: string | null = null;
    let resolved: string;
    try {
      resolved = await api.sftp.realPath(connectionId, stripTilde(startPath));
    } catch (e) {
      // The session's cwd is a convenience, not the point of the tab. When it
      // will not resolve, fall back to the login home so the user still gets a
      // browser, and say why the requested directory was not the one opened.
      try {
        resolved = await api.sftp.realPath(connectionId, '.');
        note = `Could not open ${startPath}: ${(e as Error).message}`;
      } catch (homeErr) {
        // Home itself is unreachable — the connection is not usable for SFTP
        // at all, and there is nothing to fall back to.
        error.value = (homeErr as Error).message;
        return;
      }
    }
    cwd.value = resolved;
    await refresh(connectionId);
    // `refresh` clears `error` on entry, so a fallback note is re-applied
    // after it — and only when the listing itself did not fail with something
    // more immediate.
    if (note != null && error.value == null) error.value = note;
  }

  async function refresh(connectionId: ConnectionId): Promise<void> {
    if (!cwd.value) return;
    loading.value = true;
    error.value = null;
    try {
      entries.value = await api.sftp.list(connectionId, cwd.value);
      // Sort: dirs first, then files, alphabetically.
      entries.value.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function cd(connectionId: ConnectionId, dir: string): Promise<void> {
    // Resolve relative paths against cwd.
    const next = dir.startsWith('/') ? dir : joinPosix(cwd.value, dir);
    cwd.value = await api.sftp.realPath(connectionId, next);
    await refresh(connectionId);
  }

  async function openFile(connectionId: ConnectionId, path: string): Promise<void> {
    const abs = path.startsWith('/') ? path : joinPosix(cwd.value, path);
    try {
      openContent.value = await api.sftp.readFile(connectionId, abs);
      openPath.value = abs;
      dirty.value = false;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  function setContent(content: string): void {
    openContent.value = content;
    dirty.value = true;
  }

  async function save(connectionId: ConnectionId): Promise<boolean> {
    if (!openPath.value) return false;
    saving.value = true;
    try {
      await api.sftp.writeFile(connectionId, openPath.value, openContent.value);
      dirty.value = false;
      return true;
    } catch (e) {
      error.value = (e as Error).message;
      return false;
    } finally {
      saving.value = false;
    }
  }

  function closeFile(): void {
    openPath.value = null;
    openContent.value = '';
    dirty.value = false;
  }

  function clear(): void {
    cwd.value = '';
    entries.value = [];
    error.value = null;
    closeFile();
  }

  return {
    cwd,
    entries,
    loading,
    error,
    openPath,
    openContent,
    dirty,
    saving,
    open,
    refresh,
    cd,
    openFile,
    setContent,
    save,
    closeFile,
    clear,
  };
});

/** POSIX join (the remote is always unix, even on a Windows client). */
/**
 * Turn a possibly-tilde-prefixed path into one an SFTP channel can resolve.
 *
 * A session's cwd comes from tmux and can be a literal, unexpanded `~/git`
 * (helper/parsers.ts says so explicitly, and canonicalisation there
 * deliberately never expands it). SFTP has no shell to do the expanding, so
 * `realpath("~/git")` looks for a DIRECTORY NAMED `~` and fails.
 *
 * No home lookup is needed to fix it: an SFTP session's relative root is the
 * login home — that is why `realpath(".")` is how the home is found in the
 * first place — so dropping the `~/` leaves a relative path that resolves to
 * exactly the same place, in the same single round trip.
 *
 * Only a leading `~` that refers to OUR home is handled. `~other/x` is left
 * alone: it means another user's home, which relative resolution would get
 * wrong, and failing honestly beats opening the wrong directory.
 */
export function stripTilde(path: string | undefined): string {
  if (path == null || path === '') return '.';
  if (path === '~') return '.';
  if (path.startsWith('~/')) {
    const rest = path.slice(2);
    return rest === '' ? '.' : rest;
  }
  return path;
}

function joinPosix(base: string, rel: string): string {
  if (rel === '.') return base;
  if (rel === '..') return base.replace(/\/[^/]+$/, '') || '/';
  if (base.endsWith('/')) return base + rel;
  return base + '/' + rel;
}
