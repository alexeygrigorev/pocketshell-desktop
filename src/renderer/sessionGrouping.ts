/**
 * Folder grouping for the session list — a port of the Android app's
 * host-detail grouping so both clients section sessions identically.
 *
 * Android reference (C:/Users/alexey/git/pocketshell):
 *   - `FolderListViewModel.canonicalisePath`   (FolderListViewModel.kt:2068)
 *   - `FolderListViewModel.defaultLabelForPath`(FolderListViewModel.kt:2091)
 *   - `FolderListViewModel.groupSessionsIntoFolders` (…:2140-2167)
 *   - `folderRowSort` / `recencySessionSort`   (…:2609-2637)
 *
 * The phone app has a second, outer grouping level ("watched roots" plus a
 * trailing "Other folders" bucket) driven by a per-host project-roots table.
 * The desktop has no such table, so we implement the phone's *no-watched-roots*
 * fallback path — `groupSessionsIntoFolders` — where folder groups are the
 * top level. The sort rules below are the same functions that path uses.
 *
 * ## Three projections over one set of rules (docs/SESSIONLIST.md)
 *
 * The panel renders {@link groupSessionsIntoRoots}: a tree whose top level is
 * the ROOT directory under `$HOME` (`git`, `tmp`, …) plus an `other`
 * catch-all, and whose second level is the DIRECTORY each session runs in.
 *
 * The root level is the phone's *watched-roots* level, synthesised rather than
 * read from a project-roots table the desktop does not have.
 *
 * The directory level is NOT `groupSessionsByFolder`, and the difference is
 * the whole point. §1 of the spec measured a 1:1 folder:session distribution
 * (11 folders, 11 sessions) and concluded a folder HEADER costs a row to say
 * nothing — true, and still true. So there is no header: a directory holding
 * exactly one session IS that session's row, at zero extra cost, and a branch
 * appears only where a directory genuinely holds more than one session and the
 * names are the only thing telling them apart. The measurement that killed the
 * old leaf level is exactly the measurement that makes this one free.
 *
 * `groupSessionsByFolder` stays exported as the phone-parity anchor for the
 * leaf level, and `canonicalisePath` / `defaultLabelForPath` remain the shared
 * label rules the folder-first creation flow also speaks.
 */
import { sanitisePart } from '../shared/sessionNameParts';
import type { SessionAgentKind, SessionSummary } from '../shared/types';

/** Sentinel path for sessions whose working directory is unknown. */
export const UNTRACKED_PATH = '::untracked::';
export const UNTRACKED_LABEL = 'Untracked';
export const ROOT_LABEL = '/ (root)';
export const HOME_LABEL = '~ (home)';

/** One folder section: a working directory plus the sessions living in it. */
export interface SessionFolder {
  /** Canonical folder path, or {@link UNTRACKED_PATH}. Stable list key. */
  path: string;
  /** User-visible header label (trailing path segment). */
  label: string;
  sessions: SessionSummary[];
  /** Newest activity across the folder's sessions — drives folder order. */
  mostRecentActivity: number;
  /** True when any session in the folder is attached (drives the status dot). */
  active: boolean;
}

/**
 * Canonicalise a session's working directory into a grouping key.
 * Trailing slashes are dropped so `/srv/app/` and `/srv/app` are one folder;
 * blank/unknown collapses to {@link UNTRACKED_PATH}. `~` is deliberately NOT
 * expanded — tmux reports absolute paths, so a literal `~` means the helper
 * could not resolve one.
 */
export function canonicalisePath(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return UNTRACKED_PATH;
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped || '/';
}

/**
 * Derive a non-blank header label from a canonical path: the trailing segment
 * (`/home/alexey/git/pocketshell` -> `pocketshell`), with named fallbacks for
 * the degenerate cases so a folder never reads as nameless.
 */
export function defaultLabelForPath(path: string): string {
  if (path === UNTRACKED_PATH) return UNTRACKED_LABEL;
  const clean = path.trim();
  if (!clean) return UNTRACKED_LABEL;
  const stripped = clean.replace(/\/+$/, '');
  if (!stripped) return ROOT_LABEL;
  if (stripped === '~' || stripped === '$HOME') return HOME_LABEL;
  const tail = stripped.slice(stripped.lastIndexOf('/') + 1);
  return tail.trim() ? tail : stripped;
}

/** Last-activity epoch for a session, falling back to its creation time. */
export function sessionActivity(session: SessionSummary): number {
  return session.activity || session.created || 0;
}

/**
 * Does this kind sort with the agents? Port of `SessionAgentKind.isAgentSession`
 * (FolderTreeProjection.kt:588-600).
 *
 * `probing` / `exited` group WITH the agents — they are sessions we launched,
 * just not currently classified. `unknown` (foreign, never classified) groups
 * with shells, per #821. Null/absent is the phone's "Unknown".
 */
export function isAgentSession(kind: SessionAgentKind | null | undefined): boolean {
  switch (kind) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'grok':
    case 'probing':
    case 'exited':
      return true;
    case 'shell':
    case 'unknown':
    case null:
    case undefined:
      return false;
    default:
      return false;
  }
}

/**
 * Within-folder session order, mirroring the phone's `recencySessionSort`
 * (FolderTreeProjection.kt:564-568): **agents first**, then most-recent
 * activity descending, then session name ascending.
 *
 * The agent key is the primary one on purpose — a folder full of shells should
 * never bury the agent session you are actually talking to.
 */
function compareSessions(a: SessionSummary, b: SessionSummary): number {
  const byAgent = Number(isAgentSession(b.agentKind)) - Number(isAgentSession(a.agentKind));
  if (byAgent !== 0) return byAgent;
  const byActivity = sessionActivity(b) - sessionActivity(a);
  if (byActivity !== 0) return byActivity;
  return a.name.localeCompare(b.name);
}

/** Folder order: newest activity first, ties broken by case-insensitive label. */
function compareFolders(a: SessionFolder, b: SessionFolder): number {
  const byActivity = b.mostRecentActivity - a.mostRecentActivity;
  if (byActivity !== 0) return byActivity;
  return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
}

/**
 * Group sessions into folder sections.
 *
 * Ordering, as on the phone: folders sorted by most-recent activity (desc)
 * with a case-insensitive label tiebreak, and the `Untracked` bucket pinned
 * last regardless of its activity.
 */
export function groupSessionsByFolder(sessions: SessionSummary[]): SessionFolder[] {
  const byPath = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const path = canonicalisePath(session.path);
    const bucket = byPath.get(path);
    if (bucket) bucket.push(session);
    else byPath.set(path, [session]);
  }

  const folders: SessionFolder[] = [];
  for (const [path, bucket] of byPath) {
    const ordered = [...bucket].sort(compareSessions);
    folders.push({
      path,
      label: defaultLabelForPath(path),
      sessions: ordered,
      mostRecentActivity: ordered.reduce((max, s) => Math.max(max, sessionActivity(s)), 0),
      active: ordered.some((s) => s.attached),
    });
  }

  const tracked = folders.filter((f) => f.path !== UNTRACKED_PATH).sort(compareFolders);
  const untracked = folders.filter((f) => f.path === UNTRACKED_PATH);
  return [...tracked, ...untracked];
}

/* ---------------------------------------------------------------------------
 * Row projection — the leaf of the tree, and the whole of the flat list
 * ------------------------------------------------------------------------- */

/** Characters of a label kept on the right of a middle truncation. */
const TAIL_CHARS = 8;
/** Labels at or under this length are never split — they cannot overflow. */
const SPLIT_THRESHOLD = 12;

/** One rendered session row. */
export interface SessionRow {
  session: SessionSummary;
  /**
   * Primary label: the folder basename, or the session name itself when the
   * session has no known working directory.
   */
  label: string;
  /**
   * `label` split for middle truncation. `labelHead` is the shrinkable span
   * and `labelTail` the protected one; `labelTail` is empty for short labels,
   * which render as a single span.
   */
  labelHead: string;
  labelTail: string;
  /**
   * The SESSION NAME, split for middle truncation the same way `label` is.
   *
   * This is what a branch child renders (a directory with two or more sessions
   * lists them by name), and the split matters most there: siblings in one
   * directory share a prefix by construction — `git-pocketshell` and
   * `git-pocketshell-quse` — so an end-ellipsis would render them identically.
   */
  nameHead: string;
  nameTail: string;
  /**
   * Whether to render the session name as a secondary field. False when the
   * name is derivable from the folder — the overwhelmingly common case, and
   * the whole reason the two-level tree read as duplicated.
   *
   * Only {@link flattenSessions} still consumes this. The tree answers the
   * same question structurally: a lone session is named by its directory and
   * its name lives in the tooltip, and siblings are named by the branch.
   */
  showName: boolean;
  /** Canonical folder path, or {@link UNTRACKED_PATH}. */
  folderPath: string;
  /** How many sessions share this row's folder. */
  siblings: number;
  /** True when the working directory is unknown. */
  untracked: boolean;
}

/**
 * Is `name` derivable from `label`?
 *
 * The host joins a folder's home-relative components with `-`, so every
 * derived name ENDS with the sanitised basename: `git-dataops`/`dataops`,
 * `home-alexey`/`alexey`, `var-log`/`log`. A custom name that happens to end
 * the same way is suppressed too — harmless, the tooltip still carries it.
 */
export function isDerivedName(name: string, label: string): boolean {
  const base = sanitisePart(label);
  if (!base) return false;
  return name === base || name.endsWith(`-${base}`);
}

/** Split a label so the distinguishing tail survives an overflow. */
function splitLabel(label: string): { labelHead: string; labelTail: string } {
  if (label.length <= SPLIT_THRESHOLD) return { labelHead: label, labelTail: '' };
  return {
    labelHead: label.slice(0, label.length - TAIL_CHARS),
    labelTail: label.slice(label.length - TAIL_CHARS),
  };
}

/** The last `count` segments of a path, e.g. `('/a/b/c', 2)` -> `b/c`. */
function tailSegments(path: string, count: number): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  return parts.slice(-count).join('/');
}

/**
 * Global row order (docs/SESSIONLIST.md §6): attached first, then most-recent
 * activity, then name.
 *
 * The phone's agents-first key is deliberately NOT applied here. It is a
 * *within-folder* tiebreak so a folder's shells cannot bury its agent; as a
 * GLOBAL key over one-session folders it pins every agent above every shell
 * regardless of recency, which hides precisely the recently-used shell the
 * user is hunting for. Agent-ness stays visible as the row badge.
 */
function compareRows(a: SessionSummary, b: SessionSummary): number {
  const byAttached = Number(b.attached) - Number(a.attached);
  if (byAttached !== 0) return byAttached;
  const byActivity = sessionActivity(b) - sessionActivity(a);
  if (byActivity !== 0) return byActivity;
  return a.name.localeCompare(b.name);
}

/** The shape {@link disambiguateLabels} needs: a path-derived, splittable label. */
interface PathLabelled {
  label: string;
  labelHead: string;
  labelTail: string;
  untracked: boolean;
}

/**
 * Two different folders can share a basename (`~/git/foo` and `~/work/foo`).
 * Grow every colliding label by parent segments — the same depth for the whole
 * colliding set, so they stay comparable — until they are distinct.
 *
 * Generic over the item because both levels that carry a path-derived label
 * need it: the flat list's rows, and the tree's directory nodes. `pathOf`
 * exists because those two spell the path field differently and because the
 * directory node's path is the home-relative KEY (§8), which is the spelling
 * that has already had tmux's two forms of one directory folded into it.
 */
function disambiguateLabels<T extends PathLabelled>(items: T[], pathOf: (item: T) => string): void {
  const pathsByLabel = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.untracked) continue;
    const seen = pathsByLabel.get(item.label);
    if (seen) seen.add(pathOf(item));
    else pathsByLabel.set(item.label, new Set([pathOf(item)]));
  }

  for (const [label, paths] of pathsByLabel) {
    if (paths.size < 2) continue;
    const deepest = Math.max(...[...paths].map((p) => p.split('/').filter(Boolean).length));
    let depth = 2;
    while (depth < deepest) {
      const expanded = new Set([...paths].map((p) => tailSegments(p, depth)));
      if (expanded.size === paths.size) break;
      depth += 1;
    }
    for (const item of items) {
      if (item.untracked || item.label !== label) continue;
      const grown = tailSegments(pathOf(item), depth);
      item.label = grown || item.label;
      Object.assign(item, splitLabel(item.label));
    }
  }
}

/**
 * Build one row per session, sorted, but NOT yet disambiguated.
 *
 * Disambiguation is left to the caller because its correct SCOPE differs
 * between the two projections: the flat list has to separate `~/git/foo` from
 * `~/work/foo` itself, while the tree already separates them with two root
 * headers and only needs to disambiguate within a root.
 *
 * Built on the same `canonicalisePath` / `defaultLabelForPath` /
 * `sessionActivity` rules as {@link groupSessionsByFolder}, so every
 * projection agrees about what a folder is called.
 */
function buildRows(sessions: SessionSummary[]): SessionRow[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const path = canonicalisePath(session.path);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }

  return [...sessions].sort(compareRows).map((session) => {
    const folderPath = canonicalisePath(session.path);
    const untracked = folderPath === UNTRACKED_PATH;
    // An untracked session has no folder to name it after, so its own name is
    // the only label there is — and there is nothing left to show beside it.
    const label = untracked ? session.name : defaultLabelForPath(folderPath);
    const siblings = counts.get(folderPath) ?? 1;
    const nameSplit = splitLabel(session.name);
    return {
      session,
      label,
      ...splitLabel(label),
      nameHead: nameSplit.labelHead,
      nameTail: nameSplit.labelTail,
      // Siblings share a label, so only the session name separates them —
      // show it even when it is derivable.
      showName: !untracked && (siblings > 1 || !isDerivedName(session.name, label)),
      folderPath,
      siblings,
      untracked,
    };
  });
}

/**
 * Flatten sessions into one row each, with no folder level at all.
 *
 * Retained as the tree's degenerate case and as the row model's direct test
 * surface; the panel itself renders {@link groupSessionsIntoRoots}.
 */
export function flattenSessions(sessions: SessionSummary[]): SessionRow[] {
  const rows = buildRows(sessions);
  disambiguateLabels(rows, (row) => row.folderPath);
  return rows;
}

/* ---------------------------------------------------------------------------
 * Root projection — the folder tree the panel renders
 * ------------------------------------------------------------------------- */

/** Sentinel key for the catch-all root. Stable list key, never a real path. */
export const OTHER_ROOT = '::other::';
export const OTHER_LABEL = 'other';

/**
 * One directory under a root — the panel's second level, and the level that
 * NAMES a row.
 *
 * A directory with exactly one session is not a header with a child: it is a
 * single row, labelled by the directory, that selects that session. Only a
 * directory holding two or more sessions becomes a collapsible branch, and
 * then its children are the session NAMES, because at that point the names are
 * the only thing separating them.
 *
 * A session with no known working directory is modelled as a degenerate
 * directory of its own — label = its session name, `untracked`, never a branch
 * — so the renderer has exactly one row grammar instead of a second loose-row
 * list threaded through the same sort.
 */
export interface SessionDirectory {
  /** Stable list and expansion key. Unique within a root. */
  key: string;
  /**
   * Display path: home-relative (`~/git/dataops`) when under `$HOME`, the
   * canonical path otherwise, {@link UNTRACKED_PATH} when there is none.
   * Home-relative for the same reason root keys are (§8): it is what folds
   * tmux's two spellings of one directory into a single node.
   */
  path: string;
  /** The directory's own name (leaf component), grown only on collision. */
  label: string;
  labelHead: string;
  labelTail: string;
  /** The directory's sessions, in the flat list's order. Never empty. */
  rows: SessionRow[];
  /** Newest activity across the directory — drives its order and its age. */
  mostRecentActivity: number;
  /** True when any session here is attached (drives the dot). */
  active: boolean;
  /** True when there is no reported working directory at all. */
  untracked: boolean;
  /** True when the root was recovered from the session name, not from a path. */
  inferredRoot: boolean;
}

/** One top-level folder in the panel: a `$HOME` child, or the `other` bucket. */
export interface SessionRootFolder {
  /** `~/git`, or {@link OTHER_ROOT}. Stable list key and expansion key. */
  key: string;
  /** Header label: the root's own name, or {@link OTHER_LABEL}. */
  label: string;
  /** The root's directories, ordered. */
  directories: SessionDirectory[];
  /** Sessions under this root, across every directory — the header count. */
  sessionCount: number;
  /** Newest activity across the root's sessions — drives root order. */
  mostRecentActivity: number;
  /** True when any session under this root is attached (drives the dot). */
  active: boolean;
  /** True for the catch-all, which is pinned last and reads as a bucket. */
  other: boolean;
}

/** Trim a `$HOME` value to a comparable prefix; blank becomes "unknown". */
function normaliseHome(home: string | null | undefined): string | null {
  const trimmed = (home ?? '').trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Directories that hold home directories on the platforms this app connects
 * to: Linux (`/home`), macOS (`/Users`), image-based Linux (`/var/home`), and
 * `root` — whose home is `/root` itself, not a child of anything.
 */
const HOME_PARENTS = ['/home', '/Users', '/var/home'];
const ROOT_HOME = '/root';

/**
 * Guess `$HOME` from the session paths themselves.
 *
 * The panel wants the host's real `$HOME`, but resolving it is a round trip
 * that can legitimately fail (`projects.homeError`), and with no home every
 * absolute path falls into `other` — one undifferentiated bucket, which is
 * precisely the view the user asked us to replace. So when the authoritative
 * value is missing we read the shape of the paths we already have.
 *
 * This is a fallback and is treated as one: only the standard home parents
 * count, and the most frequently seen candidate wins, so one stray `/root/x`
 * cannot outvote nine sessions under `/home/alexey`.
 */
export function inferHome(paths: (string | null | undefined)[]): string | null {
  const votes = new Map<string, number>();
  for (const raw of paths) {
    const path = canonicalisePath(raw);
    if (path === UNTRACKED_PATH) continue;
    let candidate: string | null = null;
    if (path === ROOT_HOME || path.startsWith(`${ROOT_HOME}/`)) candidate = ROOT_HOME;
    else {
      for (const parent of HOME_PARENTS) {
        if (!path.startsWith(`${parent}/`)) continue;
        const user = path.slice(parent.length + 1).split('/')[0];
        if (user) candidate = `${parent}/${user}`;
        break;
      }
    }
    if (candidate) votes.set(candidate, (votes.get(candidate) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestVotes = 0;
  for (const [candidate, count] of votes) {
    if (count > bestVotes) {
      best = candidate;
      bestVotes = count;
    }
  }
  return best;
}

/**
 * A canonical path rewritten relative to `$HOME`, or null when it is not under
 * one. `''` means the path IS `$HOME`.
 *
 * The home-relative spelling is what folds the two forms tmux reports for one
 * directory — the absolute `/home/alexey/git/x` from the active pane and the
 * literal unexpanded `~/git/x` that `session_path` can carry
 * (helper/parsers.ts:163) — into a single key. A `~` prefix needs no `home` to
 * resolve: `~` *is* home, whatever it expands to.
 */
function homeRelative(folderPath: string, home: string | null): string | null {
  if (folderPath === '~' || folderPath === '$HOME') return '';
  if (folderPath.startsWith('~/')) return folderPath.slice(2);
  const homePrefix = normaliseHome(home);
  if (homePrefix === null) return null;
  if (folderPath === homePrefix) return '';
  if (folderPath.startsWith(`${homePrefix}/`)) return folderPath.slice(homePrefix.length + 1);
  return null;
}

/**
 * Which top-level folder a session's working directory belongs to.
 *
 * Everything outside `$HOME` is `other`, and honestly so: a path outside
 * `$HOME` (`/var/log`, `/srv/app`) shares no parent with the home-rooted
 * sessions, and a session sitting in `$HOME` itself has no root folder to be
 * named after.
 */
export function rootForPath(
  folderPath: string,
  home: string | null,
): { key: string; label: string } {
  const other = { key: OTHER_ROOT, label: OTHER_LABEL };
  if (folderPath === UNTRACKED_PATH) return other;

  const relative = homeRelative(folderPath, home);
  if (relative === null) return other;

  const first = relative.split('/').find((part) => part.length > 0);
  if (!first) return other;
  return { key: `~/${first}`, label: first };
}

/**
 * The grouping key for a session's DIRECTORY — the same home-relative rewrite
 * the root key gets, applied at full depth (`~/git/dataops`).
 *
 * Written home-relative for exactly the reason {@link rootForPath} is: without
 * it, one directory reported both ways would render as two identically
 * labelled rows sitting next to each other.
 */
export function directoryKey(folderPath: string, home: string | null): string {
  if (folderPath === UNTRACKED_PATH) return UNTRACKED_PATH;
  const relative = homeRelative(folderPath, home);
  if (relative === null) return folderPath;
  return relative ? `~/${relative}` : '~';
}

/**
 * Recover a session's ROOT from its NAME when no working directory was
 * reported at all.
 *
 * This is a heuristic, and it is deliberately a shallow one. Session names on
 * this host are DERIVED from the path: `sessionBaseName` joins the
 * home-relative components with `-` after running each through `sanitisePart`
 * (src/main/projects/sessionName.ts). So `~/git/red-stamp-sound` becomes
 * `git-red-stamp-sound`, and the leading component of the name is the root the
 * session lives under — recoverable even when tmux reports no cwd, which
 * happens when the active pane has exited or was never recorded.
 *
 * It recovers the ROOT ONLY, never the directory, because the derivation is
 * not invertible past the first component: `-` is both the component separator
 * AND a legal character inside a component, so `git-dtc-website-import` is
 * genuinely ambiguous between `~/git/dtc-website-import` and
 * `~/git/dtc-website/import`. Inventing a directory row from that guess would
 * be worse than not having one, so a name-recovered session sits as a direct
 * child of its root instead.
 *
 * @param knownLabels the root labels that exist from REAL paths. Matching only
 *   against those is what stops the heuristic inventing structure: a session
 *   called `foo-bar` must not conjure a `foo` root nothing else lives in.
 * @returns the matching root label, or null to leave the session in `other`.
 */
export function rootFromSessionName(name: string, knownLabels: Iterable<string>): string | null {
  const first = name.split('-').find((part) => part.length > 0);
  if (!first) return null;
  for (const label of knownLabels) {
    // Compare sanitised: the name carries the sanitised form of the folder
    // component, so a root literally called `my.project` is `my_project` here.
    if (sanitisePart(label) === first) return label;
  }
  return null;
}

/** Root order: newest activity first, case-insensitive label tiebreak. */
function compareRoots(a: SessionRootFolder, b: SessionRootFolder): number {
  const byActivity = b.mostRecentActivity - a.mostRecentActivity;
  if (byActivity !== 0) return byActivity;
  return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
}

/**
 * Directory order within a root, mirroring the row order it replaces: a
 * directory holding an attached session first, then most-recent activity
 * descending, then a case-insensitive label.
 *
 * Attached-first is lifted to this level rather than dropped, because at the
 * 1:1 distribution the directory row IS the session row — demoting the key
 * would move the session the user is currently in off the top of its root,
 * which is the one thing the sort exists to prevent.
 */
function compareDirectories(a: SessionDirectory, b: SessionDirectory): number {
  const byAttached = Number(b.active) - Number(a.active);
  if (byAttached !== 0) return byAttached;
  const byActivity = b.mostRecentActivity - a.mostRecentActivity;
  if (byActivity !== 0) return byActivity;
  return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
}

/**
 * Group sessions into the panel's folder tree.
 *
 * @param home the host's `$HOME`, or null — in which case it is inferred from
 *   the paths ({@link inferHome}) rather than surrendering every row to
 *   `other`.
 *
 * Roots sort by most-recent activity descending, as folders do on the phone,
 * with `other` pinned last however recent it is: it is a bucket, not a place,
 * and letting it float to the top would put the least-organised rows where the
 * eye lands first. Rows keep the flat list's global order within each root.
 */
export function groupSessionsIntoRoots(
  sessions: SessionSummary[],
  home: string | null = null,
): SessionRootFolder[] {
  const resolvedHome = normaliseHome(home) ?? inferHome(sessions.map((s) => s.path));
  const rows = buildRows(sessions);

  // Pass 1: the roots that exist from REAL paths. The name heuristic below can
  // only file into these, so it can place a session but never invent a place.
  const rootLabels = new Map<string, string>();
  for (const row of rows) {
    if (row.untracked) continue;
    const { key, label } = rootForPath(row.folderPath, resolvedHome);
    if (key !== OTHER_ROOT) rootLabels.set(label, key);
  }

  // Pass 2: place every row, then group its root's rows into directories.
  const byRoot = new Map<string, { key: string; label: string; rows: SessionRow[] }>();
  for (const row of rows) {
    let placement = rootForPath(row.folderPath, resolvedHome);
    if (row.untracked) {
      const recovered = rootFromSessionName(row.session.name, rootLabels.keys());
      const key = recovered !== null ? rootLabels.get(recovered) : undefined;
      if (recovered !== null && key !== undefined) placement = { key, label: recovered };
    }
    const bucket = byRoot.get(placement.key);
    if (bucket) bucket.rows.push(row);
    else byRoot.set(placement.key, { ...placement, rows: [row] });
  }

  const folders: SessionRootFolder[] = [];
  for (const bucket of byRoot.values()) {
    const directories = buildDirectories(bucket.rows, resolvedHome);
    // A session with no reported cwd can only have reached a REAL root through
    // the name heuristic, so that pairing is what marks the guess — there is
    // no other way for an untracked row to be anywhere but `other`.
    for (const dir of directories) dir.inferredRoot = dir.untracked && bucket.key !== OTHER_ROOT;
    // Scoped to the root: two `foo` directories under one root still need
    // growing apart, but `~/git/foo` vs `~/work/foo` are already told apart by
    // their two headers, so growing both would be the header's information a
    // second time.
    disambiguateLabels(directories, (dir) => dir.path);
    directories.sort(compareDirectories);
    folders.push({
      key: bucket.key,
      label: bucket.label,
      directories,
      sessionCount: bucket.rows.length,
      mostRecentActivity: directories.reduce((max, d) => Math.max(max, d.mostRecentActivity), 0),
      active: directories.some((d) => d.active),
      other: bucket.key === OTHER_ROOT,
    });
  }

  const rooted = folders.filter((f) => !f.other).sort(compareRoots);
  const other = folders.filter((f) => f.other);
  return [...rooted, ...other];
}

/**
 * Group one root's rows into directory nodes, preserving the incoming row
 * order inside each.
 *
 * Untracked rows get a key of their own rather than sharing the
 * {@link UNTRACKED_PATH} sentinel, so they stay one row each. Merging them
 * would produce a branch labelled `Untracked` whose children are the only
 * labels those sessions ever had — a level of nesting that hides the one fact
 * the row carries.
 */
function buildDirectories(rows: SessionRow[], home: string | null): SessionDirectory[] {
  const byKey = new Map<string, SessionDirectory>();
  for (const row of rows) {
    const path = row.untracked ? UNTRACKED_PATH : directoryKey(row.folderPath, home);
    const key = row.untracked ? `${UNTRACKED_PATH} ${row.session.name}` : path;
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    // An untracked session has no directory to name it after, so its own name
    // is the only label there is — the same rule the flat row already used.
    const label = row.untracked ? row.session.name : defaultLabelForPath(path);
    byKey.set(key, {
      key,
      path,
      label,
      ...splitLabel(label),
      rows: [row],
      mostRecentActivity: 0,
      active: false,
      untracked: row.untracked,
      inferredRoot: false,
    });
  }

  const directories = [...byKey.values()];
  for (const dir of directories) {
    dir.mostRecentActivity = dir.rows.reduce(
      (max, r) => Math.max(max, sessionActivity(r.session)),
      0,
    );
    dir.active = dir.rows.some((r) => r.session.attached);
  }
  return directories;
}
