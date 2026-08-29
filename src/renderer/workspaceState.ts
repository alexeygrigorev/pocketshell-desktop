/**
 * Cross-restart persistence for a folder workspace's tab state.
 *
 * The workspace remembers three things for as long as the window lives — which
 * Files tabs are open, which tab is selected, and the selection history — and
 * all three used to live ONLY in a module-scoped `Map`, so closing the app and
 * opening it again landed on the host picker and then the bare session list:
 * the tabs themselves were all still on the host (tmux kept them), but the app
 * no longer knew which folder held them, which of them the user had been
 * looking at, or that a Files tab was open at all.
 *
 * Two records here close that gap. Both are written by the workspace's own
 * `persist()` and read back when a workspace opens with nothing in memory:
 *
 *   - the workspace's tab state, per host AND folder, so relaunching into a
 *     folder finds the same tabs with the same one in front;
 *   - the folder each host was last open on, so the picker — and the
 *     auto-connect — can land IN the workspace rather than beside it.
 *
 * What is deliberately NOT persisted is the session list itself. The host is
 * authoritative: the bar is re-derived from the live tmux list on every
 * refresh, so a session killed while the app was closed produces no tab —
 * there is nothing to remove at restore time, only stored ids pointing at
 * where it was, and those obey the same rule the MRU and the manual order
 * already apply inside a session: a dead id is
 * inert, is pruned from the lists once the bar it describes exists again, and
 * a stored SELECTION naming one simply falls back to the first tab. A stored
 * selection is a preference, not a tab, so it is resolved at read time rather
 * than eagerly nulled — nulling it in a watch would also break the create
 * flow, which points `selected` at a session half a second before the list
 * that contains it arrives.
 *
 * ## Why `localStorage`, and why these keys
 *
 * Following the precedent the manual tab order (`ps.tabOrder.*`) and the
 * session panel's width already set: the settings store is for preferences a
 * user sets BY NAME in the Settings overlay, and "which tabs were open" is raw
 * layout state, which has always gone to `localStorage` directly. Both records
 * key on the HOST ALIAS — exactly as stable as the folder path beside it, and
 * unlike a connection id (an opaque handle minted per connect) it survives a
 * restart, which is the whole point here.
 */

/** A Files tab is an id AND the directory it was opened at. */
export interface FilesTabRecord {
  /**
   * Stable identity, unique within the workspace — minted by the workspace as
   * `` `${folder}::files:${Date.now()}` ``.
   */
  id: string;
  /**
   * The directory this tab starts at. Null means "never given a seed", which
   * the workspace resolves to the folder.
   *
   * The id alone was enough while every Files tab in a workspace opened at the
   * folder. It stopped being enough with "open in a new tab" from the file
   * tree, which opens one at an arbitrary path — and the seed has to outlive
   * the tab's unmount, now also across a relaunch, or coming back to the tab
   * would drop it at the folder again. (The files store remembers where the
   * user then NAVIGATED to; this is only where the tab starts, which the store
   * has no way to know.)
   */
  path: string | null;
}

/**
 * The persisted shape of a folder workspace's tab state.
 *
 * One shape, two lifetimes: this is what `localStorage` holds between
 * launches, and what the workspace's in-memory map holds within one. They are
 * kept structurally identical on purpose — the map entry IS the record, and
 * `persist()` writes it verbatim rather than converting.
 */
export interface WorkspaceMemoryRecord {
  filesTabs: FilesTabRecord[];
  /** The selected tab id, or null for "the first one". */
  activeTab: string | null;
  /**
   * Tabs in the order they were last selected, most-recent LAST
   *. Remembered alongside the tabs rather than rebuilt
   * on entry, so the FIRST close after a relaunch still lands on the
   * previously active tab instead of falling back to adjacency.
   */
  mru: string[];
}

/** localStorage key for one workspace's tab state. */
export function workspaceMemoryKey(host: string, folder: string): string {
  return `ps.workspace.${host}.${folder}`;
}

/** localStorage key for the folder a host was last open on. */
export function lastFolderKey(host: string): string {
  return `ps.lastFolder.${host}`;
}

/**
 * The stored tab state for [key], or null when there is none.
 *
 * Validated rather than trusted — this is user-writable JSON on disk, and a
 * hand-edited or half-written record must degrade to "nothing remembered"
 * rather than smuggle a non-string id into a list of tab ids. Anything that is
 * not a well-formed record, and any FILES entry without an id, is dropped;
 * everything else survives field by field, so one bad field costs itself and
 * not the record.
 */
export function readWorkspaceMemory(key: string): WorkspaceMemoryRecord | null {
  if (typeof localStorage === 'undefined') return null;
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const doc = parsed as Record<string, unknown>;
  return {
    filesTabs: readFilesTabs(doc['filesTabs']),
    activeTab: typeof doc['activeTab'] === 'string' ? doc['activeTab'] : null,
    mru: readStringList(doc['mru']),
  };
}

function readFilesTabs(value: unknown): FilesTabRecord[] {
  if (!Array.isArray(value)) return [];
  const out: FilesTabRecord[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const doc = entry as Record<string, unknown>;
    if (typeof doc['id'] !== 'string' || doc['id'].length === 0) continue;
    out.push({ id: doc['id'], path: typeof doc['path'] === 'string' ? doc['path'] : null });
  }
  return out;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Store [memory] under [key].
 *
 * Failures — quota, a locked profile — are swallowed deliberately: losing the
 * restored tabs on the NEXT launch beats throwing out of a tab click.
 */
export function writeWorkspaceMemory(key: string, memory: WorkspaceMemoryRecord): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(memory));
  } catch {
    // Quota, or a locked profile.
  }
}

/**
 * The folder [host] was last open on, or null when it has none — never
 * launched into that host, or the key was never written. An empty string reads
 * as none: a route with an empty folder param is not a workspace.
 */
export function readLastFolder(host: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  const folder = localStorage.getItem(lastFolderKey(host));
  return folder === null || folder === '' ? null : folder;
}

/** Record [folder] as the folder [host] was last open on. */
export function writeLastFolder(host: string, folder: string): void {
  if (typeof localStorage === 'undefined' || folder === '') return;
  try {
    localStorage.setItem(lastFolderKey(host), folder);
  } catch {
    // Same tolerance as {@link writeWorkspaceMemory}.
  }
}
