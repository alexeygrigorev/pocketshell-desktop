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
 * a ROOT plus an `other` catch-all, and whose second level is the DIRECTORY
 * each session runs in.
 *
 * The root level is the phone's *watched-roots* level, and it now works the
 * phone's way: the user REGISTERS roots (`settings.sessionRoots`), and
 * whatever falls under none of them goes to `other`. When nothing is
 * registered — the default, and every existing install — roots are still
 * SYNTHESISED from `$HOME`'s children, so the panel looks exactly as it did
 * before anybody visited Settings. See the block above {@link normaliseRootPath}
 * for the ported matching semantics and the three deliberate divergences.
 *
 * The directory level is NOT `groupSessionsByFolder`, and the difference is
 * that it is scoped to a root and keyed home-relative.
 *
 * Every directory is a node with its sessions as children, whatever it holds.
 * §1 of the spec measured a 1:1 folder:session distribution (11 folders, 11
 * sessions) and two revisions concluded from it that a directory holding one
 * session should collapse into that session's row. The measurement was real;
 * the conclusion was wrong in practice, because at that distribution the
 * collapse fires on nearly every node and what renders is a flat list under
 * one header — not the `git -> folder -> session` tree the user asked for
 * three times (docs/SESSIONLIST.md, revision 3). The projection below is
 * therefore uniform, and the renderer no longer branches on `rows.length`.
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
   * This is what every LEAF row renders, and the split matters most where a
   * directory holds siblings: they share a prefix by construction —
   * `git-pocketshell` and `git-pocketshell-quse` — so an end-ellipsis would
   * render them identically.
   */
  nameHead: string;
  nameTail: string;
  /**
   * Whether to render the session name as a secondary field. False when the
   * name is derivable from the folder — the overwhelmingly common case, and
   * the whole reason the two-level tree read as duplicated.
   *
   * Only {@link flattenSessions} still consumes this. The tree answers the
   * same question structurally: the directory is said once, by the header, and
   * every leaf below it is named by its session name.
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
export function splitLabel(label: string): { labelHead: string; labelTail: string } {
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
/**
 * The path a session GROUPS under, which is not always the path it runs in.
 *
 * A session in a linked git worktree groups under the repository the worktree
 * belongs to (docs/WORKSPACE.md §6.5) — the user's "this one should be in
 * dtc-website actually" about a session running in `~/git/merry-sniffing-token`.
 * `repoRoot` is set by the main process only for worktrees, so for every other
 * session this is just its own path.
 *
 * Note what does NOT change: `session.path` is untouched, and it is what the
 * Files tab opens at. Grouping answers "where does this work belong"; the path
 * answers "where is this process standing", and for a worktree those are
 * genuinely different places.
 */
function groupingPath(session: SessionSummary): string {
  return canonicalisePath(session.repoRoot ?? session.path);
}

function buildRows(sessions: SessionSummary[]): SessionRow[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const path = groupingPath(session);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }

  return [...sessions].sort(compareRows).map((session) => {
    const folderPath = groupingPath(session);
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
 * One directory under a root — the panel's middle level.
 *
 * Always a collapsible node, never folded into its own child, however few
 * sessions it holds: `rows.length` is a count, not a rendering mode. Its
 * children are the session NAMES, at every size, because the header has
 * already said the directory and repeating it is what made the old rows read
 * as doubled.
 *
 * A session with no known working directory is modelled as a degenerate
 * directory of its own — label = its session name, `untracked`, exactly one
 * row — so the renderer sorts one list instead of threading a second loose-row
 * array through the same comparator. It is the one node the panel draws as a
 * single row, because there is no directory there to draw a level for; see
 * SessionTree.vue.
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
  /**
   * True when this root came from the user's registered list rather than from
   * the shape of the paths. Only a registered root can have `sessionCount: 0`
   * — a derived root exists BECAUSE a session is in it — so this is what lets
   * the panel say "registered, nothing running here" instead of drawing a
   * header with nothing under it and no explanation.
   */
  configured: boolean;
}

/* ---------------------------------------------------------------------------
 * Registered roots — the top level, when the user has configured one
 *
 * The phone calls these WATCHED ROOTS and stores them per host in a Room table
 * (`project_roots`: `{hostId, label, path}`, ProjectRootEntity.kt:26-32). The
 * desktop stores them app-level, in `stores/settings.ts`, for one reason: a
 * registered root is written home-relative (`~/git`), and `~/git` means the
 * same place on every host the user connects to. A per-host table would make
 * the user re-register the same three roots on each box.
 *
 * Matching semantics are ported from FolderTreeProjection.kt verbatim, because
 * that is the behaviour the user already knows from the phone:
 *   - prefix match on a `/` boundary, so `~/git` never claims `~/gitlab`
 *     (`pathWithinRoot`, :310);
 *   - longest match wins when roots nest, first-registered breaking a tie
 *     (`bestRootForPath`, :475);
 *   - a session sitting exactly ON the root belongs to it;
 *   - anything matching no root goes to `other`, pinned last (:276);
 *   - a registered root with no sessions still renders (:179-241).
 *
 * Three deliberate divergences, all recorded in docs/SESSIONLIST.md §12:
 *   - the phone's no-roots fallback dumps EVERYTHING into `Other folders`
 *     (:253-274). We keep deriving roots from `$HOME` instead, so a user who
 *     has configured nothing sees exactly what they saw before.
 *   - the phone dedupes roots by their STORED spelling, so `~/git` and
 *     `/home/me/git` survive as two identical-looking nodes. We dedupe on the
 *     resolved key, so they cannot.
 *   - the phone collapses a session's directory to the FIRST segment under its
 *     root (`projectPathUnderRoot`, :538). We keep the full directory the
 *     session actually runs in; see §12 for the argument, which is close.
 * ------------------------------------------------------------------------- */

/**
 * Upper bound on the registered-root list, applied when settings are parsed.
 *
 * Not a UI limit anybody should reach — it is a guard on a hand-editable JSON
 * blob, so a corrupt or pathological array cannot make the panel render
 * thousands of headers.
 */
export const SESSION_ROOTS_MAX = 32;

/**
 * Clean one registered root into the form that gets STORED, or null if it is
 * not usable as a root at all.
 *
 * Stored roots keep the spelling the user typed — `~/git` stays `~/git`,
 * `/home/alexey/git` stays absolute — because settings are app-level while
 * `$HOME` is per-host, so at write time there is no home to rewrite against.
 * The two spellings are folded together later and per host by
 * {@link resolveRoots}, through `directoryKey`: the same rule that already
 * folds tmux's two spellings of one directory into one node. One rule applied
 * twice, rather than a second normalisation free to drift from it.
 */
export function normaliseRootPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // A control character cannot be in a path the user meant to type, and a
  // newline inside a stored root would corrupt every listing that prints it.
  if ([...value].some((ch) => ch < ' ')) return null;
  const canonical = canonicalisePath(value);
  if (canonical === UNTRACKED_PATH) return null;
  // `..` is refused rather than resolved: resolving it needs a real filesystem,
  // and a root that names a different directory depending on where it is
  // resolved from is not a root. The phone refuses it too
  // (WatchedFoldersViewModel.kt:368-388).
  if (canonical.split('/').includes('..')) return null;
  // Anchored, as on the phone: absolute, or under `~`. A bare `git` would be
  // relative to nothing this panel can name.
  if (canonical !== '~' && !canonical.startsWith('~/') && !canonical.startsWith('/')) return null;
  return canonical;
}

/**
 * Clean a whole stored list: drop what {@link normaliseRootPath} rejects, drop
 * exact repeats, and cap the length.
 *
 * Dedupe here is exact-string only. `~/git` and `/home/alexey/git` are still
 * two entries at this point and are collapsed by {@link resolveRoots} once a
 * host's `$HOME` is known — which is the only place that question has an
 * answer.
 */
export function normaliseRootList(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (out.length >= SESSION_ROOTS_MAX) break;
    const root = normaliseRootPath(value);
    if (root !== null && !out.includes(root)) out.push(root);
  }
  return out;
}

/** A registered root, resolved against one host's `$HOME`. */
export interface ResolvedRoot {
  /** Home-relative comparison key (`~/git`), or an absolute path outside home. */
  key: string;
  /** Header label: the root's own name, grown on collision. */
  label: string;
  /** The stored spelling, kept for the header tooltip. */
  source: string;
}

/**
 * Two registered roots can share a basename (`~/git/work`, `~/clients/work`).
 * Give every member of a colliding set its home-relative path instead, so no
 * two headers read identically. Deliberately simpler than the directory
 * level's `disambiguateLabels`: a root list is short, user-authored, and the
 * user can rename the collision away by registering a different root.
 */
function labelRootsApart(roots: ResolvedRoot[]): void {
  const counts = new Map<string, number>();
  for (const root of roots) counts.set(root.label, (counts.get(root.label) ?? 0) + 1);
  for (const root of roots) {
    if ((counts.get(root.label) ?? 0) < 2) continue;
    root.label = root.key.startsWith('~/') ? root.key.slice(2) : root.key;
  }
}

/**
 * Resolve the stored root list against a host's `$HOME`, in registered order.
 *
 * Deduping happens on the RESOLVED key, which is what stops `~/git` and
 * `/home/alexey/git` — the same directory, two spellings, both perfectly
 * reasonable things for a user to type — rendering as two identical branches.
 * The phone dedupes on the stored spelling and does render both.
 */
export function resolveRoots(roots: readonly string[], home: string | null): ResolvedRoot[] {
  const resolved: ResolvedRoot[] = [];
  const seen = new Set<string>();
  for (const source of roots) {
    const canonical = normaliseRootPath(source);
    if (canonical === null) continue;
    const key = directoryKey(canonical, home);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ key, label: defaultLabelForPath(key), source: canonical });
  }
  labelRootsApart(resolved);
  return resolved;
}

/**
 * Is `path` at or below `root`? Port of `pathWithinRoot`
 * (FolderTreeProjection.kt:310).
 *
 * The `/` boundary is the whole point: a plain `startsWith` would let `~/git`
 * swallow `~/gitlab`, and a user who registers one of those and not the other
 * means it.
 */
export function pathWithinRoot(path: string, root: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/**
 * Which registered root claims this working directory, or null for none.
 *
 * **Longest match wins**, so registering both `~/git` and `~/git/work` puts a
 * session in `~/git/work/thing` under `work` rather than under `git` — the
 * more specific declaration is the more deliberate one. A tie is impossible
 * between distinct keys of equal length that both match, but the comparison is
 * strict `>` regardless, so the FIRST-registered root wins one if it ever
 * arises; that is `maxByOrNull`'s behaviour on the phone.
 */
export function bestRootForPath(
  folderPath: string,
  home: string | null,
  roots: readonly ResolvedRoot[],
): ResolvedRoot | null {
  if (folderPath === UNTRACKED_PATH) return null;
  const key = directoryKey(folderPath, home);
  let best: ResolvedRoot | null = null;
  for (const root of roots) {
    if (!pathWithinRoot(key, root.key)) continue;
    if (best === null || root.key.length > best.key.length) best = root;
  }
  return best;
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
 * Attached-first is lifted to this level rather than dropped: at the 1:1
 * distribution a directory is a one-session node, so demoting the key would
 * move the session the user is currently in off the top of its root, which is
 * the one thing the sort exists to prevent. The header now sits above that
 * session rather than being it, which changes nothing about the ordering.
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
 * @param roots the user's REGISTERED roots (`settings.sessionRoots`), in the
 *   order they were registered. Empty — the default — keeps the original
 *   behaviour of deriving roots from `$HOME`'s children, so nothing changes
 *   for a user who has configured nothing.
 *
 * **Root order** depends on which mode is in play. Registered roots render in
 * REGISTERED ORDER: a declared list is itself an ordering, and re-sorting it
 * by recency would reshuffle the panel's top level under the sessions store's
 * refresh timer. Derived roots have no declared order, so they keep the
 * most-recent-activity sort. Either way `other` is pinned last, however recent
 * it is: it is a bucket, not a place, and letting it float to the top would
 * put the least-organised rows where the eye lands first. Rows keep the flat
 * list's global order within each root.
 */
export function groupSessionsIntoRoots(
  sessions: SessionSummary[],
  home: string | null = null,
  roots: readonly string[] = [],
): SessionRootFolder[] {
  const resolvedHome = normaliseHome(home) ?? inferHome(sessions.map((s) => s.path));
  const configured = resolveRoots(roots, resolvedHome);
  const configuredKeys = new Set(configured.map((root) => root.key));
  const rows = buildRows(sessions);

  // Pass 1: the roots the NAME heuristic (§4.6) is allowed to file into.
  //
  // Configured: the registered list. A root the user declared is BETTER
  // evidence than one we inferred, so a no-cwd session called `tmp-scratch`
  // reaches a registered `~/tmp` even when nothing else is running there.
  // Derived: only roots that exist from REAL paths, which is what stops the
  // heuristic inventing a place rather than merely placing a session.
  const rootLabels = new Map<string, string>();
  if (configured.length > 0) {
    for (const root of configured) rootLabels.set(root.label, root.key);
  } else {
    for (const row of rows) {
      if (row.untracked) continue;
      const { key, label } = rootForPath(row.folderPath, resolvedHome);
      if (key !== OTHER_ROOT) rootLabels.set(label, key);
    }
  }

  /** Where a row's working directory belongs, before the name heuristic. */
  function placeRow(row: SessionRow): { key: string; label: string } {
    if (configured.length === 0) return rootForPath(row.folderPath, resolvedHome);
    const match = bestRootForPath(row.folderPath, resolvedHome, configured);
    if (match === null) return { key: OTHER_ROOT, label: OTHER_LABEL };
    return { key: match.key, label: match.label };
  }

  // Pass 2: place every row, then group its root's rows into directories.
  const byRoot = new Map<string, { key: string; label: string; rows: SessionRow[] }>();
  // Registered roots are seeded EMPTY, before any row is placed, so a root the
  // user declared still renders when nothing is running in it — including on a
  // host where the directory does not exist at all. A registered root is a
  // statement of intent, not a fact derived from the session list, and a
  // setting that silently shows nothing reads as a broken setting.
  for (const root of configured) {
    byRoot.set(root.key, { key: root.key, label: root.label, rows: [] });
  }
  for (const row of rows) {
    let placement = placeRow(row);
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
      configured: configuredKeys.has(bucket.key),
    });
  }

  const rooted = folders.filter((f) => !f.other);
  const other = folders.filter((f) => f.other);
  if (configured.length > 0) {
    // Registered order. Every non-`other` key here came from `configured` —
    // `placeRow` and the name heuristic can only produce registered keys or
    // `other` — so the lookup always hits.
    const rank = new Map(configured.map((root, index) => [root.key, index]));
    rooted.sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  } else {
    rooted.sort(compareRoots);
  }
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
