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
 * The panel renders {@link groupSessionsIntoRoots}: a two-level tree whose top
 * level is the ROOT directory under `$HOME` (`git`, `tmp`, …) plus an `other`
 * catch-all, each expanding to the flat session rows living beneath it.
 *
 * That is the phone's *watched-roots* level, synthesised rather than read from
 * a project-roots table the desktop does not have. It is deliberately NOT
 * `groupSessionsByFolder`: on a real host the folder:session distribution is
 * 1:1 (11 folders, 11 sessions), so a header per LEAF folder costs a row to
 * say nothing, and because the session name is derived from the folder path
 * (`~/git/dataops` -> `git-dataops`, src/main/projects/sessionName.ts) header
 * and row were the same fact twice. Roots have real fan-out — all 11 of those
 * sessions live under one `git` — which is what makes the level earn its rows.
 *
 * The leaf rows are the flat list's rows unchanged ({@link SessionRow}), so
 * everything that design bought — folder basename as the label, derived-name
 * suppression, middle truncation, attached-first ordering — survives inside
 * the tree. `groupSessionsByFolder` stays exported as the phone-parity anchor
 * for the leaf level, and `canonicalisePath` / `defaultLabelForPath` remain
 * the shared label rules the folder-first creation flow also speaks.
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
   * Whether to render the session name as a secondary field. False when the
   * name is derivable from the folder — the overwhelmingly common case, and
   * the whole reason the two-level tree read as duplicated.
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

/**
 * Two different folders can share a basename (`~/git/foo` and `~/work/foo`).
 * Grow every colliding label by parent segments — the same depth for the whole
 * colliding set, so they stay comparable — until they are distinct.
 */
function disambiguateLabels(rows: SessionRow[]): void {
  const pathsByLabel = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.untracked) continue;
    const seen = pathsByLabel.get(row.label);
    if (seen) seen.add(row.folderPath);
    else pathsByLabel.set(row.label, new Set([row.folderPath]));
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
    for (const row of rows) {
      if (row.untracked || row.label !== label) continue;
      const grown = tailSegments(row.folderPath, depth);
      row.label = grown || row.label;
      Object.assign(row, splitLabel(row.label));
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
    return {
      session,
      label,
      ...splitLabel(label),
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
  disambiguateLabels(rows);
  return rows;
}

/* ---------------------------------------------------------------------------
 * Root projection — the folder tree the panel renders
 * ------------------------------------------------------------------------- */

/** Sentinel key for the catch-all root. Stable list key, never a real path. */
export const OTHER_ROOT = '::other::';
export const OTHER_LABEL = 'other';

/** One top-level folder in the panel: a `$HOME` child, or the `other` bucket. */
export interface SessionRootFolder {
  /** `~/git`, or {@link OTHER_ROOT}. Stable list key and expansion key. */
  key: string;
  /** Header label: the root's own name, or {@link OTHER_LABEL}. */
  label: string;
  rows: SessionRow[];
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
 * Which top-level folder a session's working directory belongs to.
 *
 * The key is always written home-relative (`~/git`) so the two spellings of
 * the same directory — the absolute `/home/alexey/git/x` tmux usually reports
 * and the literal unexpanded `~/git/x` it sometimes does (helper/parsers.ts:163)
 * — land in ONE bucket instead of two identically-labelled ones. A `~` prefix
 * needs no `home` to resolve: `~` *is* home, whatever it expands to.
 *
 * Everything else is `other`, and honestly so: a path outside `$HOME`
 * (`/var/log`, `/srv/app`) shares no parent with the home-rooted sessions, and
 * a session sitting in `$HOME` itself has no root folder to be named after.
 */
export function rootForPath(
  folderPath: string,
  home: string | null,
): { key: string; label: string } {
  const other = { key: OTHER_ROOT, label: OTHER_LABEL };
  if (folderPath === UNTRACKED_PATH) return other;

  const homePrefix = normaliseHome(home);
  let relative: string | null = null;
  if (folderPath === '~' || folderPath === '$HOME') relative = '';
  else if (folderPath.startsWith('~/')) relative = folderPath.slice(2);
  else if (homePrefix !== null && folderPath === homePrefix) relative = '';
  else if (homePrefix !== null && folderPath.startsWith(`${homePrefix}/`)) {
    relative = folderPath.slice(homePrefix.length + 1);
  }
  if (relative === null) return other;

  const first = relative.split('/').find((part) => part.length > 0);
  if (!first) return other;
  return { key: `~/${first}`, label: first };
}

/** Root order: newest activity first, case-insensitive label tiebreak. */
function compareRoots(a: SessionRootFolder, b: SessionRootFolder): number {
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

  const byKey = new Map<string, SessionRootFolder>();
  for (const row of buildRows(sessions)) {
    const { key, label } = rootForPath(row.folderPath, resolvedHome);
    const folder = byKey.get(key);
    if (folder) folder.rows.push(row);
    else {
      byKey.set(key, {
        key,
        label,
        rows: [row],
        mostRecentActivity: 0,
        active: false,
        other: key === OTHER_ROOT,
      });
    }
  }

  const folders = [...byKey.values()];
  for (const folder of folders) {
    // Scoped to the root: two `foo` folders under one root still need growing
    // apart, but `~/git/foo` vs `~/work/foo` are already separated by headers.
    disambiguateLabels(folder.rows);
    folder.mostRecentActivity = folder.rows.reduce(
      (max, r) => Math.max(max, sessionActivity(r.session)),
      0,
    );
    folder.active = folder.rows.some((r) => r.session.attached);
  }

  const rooted = folders.filter((f) => !f.other).sort(compareRoots);
  const other = folders.filter((f) => f.other);
  return [...rooted, ...other];
}
