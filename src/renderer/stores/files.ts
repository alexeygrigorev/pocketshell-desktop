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

  async function open(connectionId: ConnectionId): Promise<void> {
    // Default to the testuser home; sftp realPath('.') resolves it.
    cwd.value = await api.sftp.realPath(connectionId, '.');
    await refresh(connectionId);
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
function joinPosix(base: string, rel: string): string {
  if (rel === '.') return base;
  if (rel === '..') return base.replace(/\/[^/]+$/, '') || '/';
  if (base.endsWith('/')) return base + rel;
  return base + '/' + rel;
}
