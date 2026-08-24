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
 * ## Grouping semantics are shared; PRESENTATION is not (docs/SESSIONLIST.md)
 *
 * The desktop panel no longer RENDERS these folder sections. On a real host
 * the distribution is 1:1 — 11 folders holding exactly 11 sessions — so every
 * folder header cost a row to say nothing, and because the session name is
 * derived from the folder path (`~/git/dataops` -> `git-dataops`,
 * src/main/projects/sessionName.ts) the two lines were the same fact twice,
 * both truncated to `git-…`. The phone escapes this because its top level is
 * watched ROOTS, which have real fan-out; the desktop ported only the
 * degenerate fallback.
 *
 * So the panel renders {@link flattenSessions} — one row per session, folder
 * basename as the label — while `groupSessionsByFolder` stays exported and
 * authoritative: it is the phone-parity anchor, `canonicalisePath` /
 * `defaultLabelForPath` are the shared label rules, and the folder-first
 * creation flow still speaks folders.
 */
import type { SessionAgentKind, SessionSummary } from '../shared/types';
// Value import across the main/renderer line, deliberately and narrowly:
// `sanitisePart` is pure string logic with no Node dependency, and the
// redundancy test below must use the EXACT regex the host derives names with
// or it will suppress the wrong rows. docs/SESSIONLIST.md §8 asks for it to be
// lifted into `src/shared/` and re-exported; that file belongs to another
// owner, so this import stands in until it moves. Nothing else crosses.
import { sanitisePart } from '../main/projects/sessionName';

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
 * Flat projection — what the panel actually renders (docs/SESSIONLIST.md)
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
 * Flatten sessions into one row each — the panel's rendering model.
 *
 * Built on the same `canonicalisePath` / `defaultLabelForPath` /
 * `sessionActivity` rules as {@link groupSessionsByFolder}, so both
 * projections agree about what a folder is called.
 */
export function flattenSessions(sessions: SessionSummary[]): SessionRow[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const path = canonicalisePath(session.path);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }

  const rows: SessionRow[] = [...sessions].sort(compareRows).map((session) => {
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

  disambiguateLabels(rows);
  return rows;
}
