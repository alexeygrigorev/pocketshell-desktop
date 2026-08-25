/**
 * What the Files tab's tree actually renders: a capped, optionally filtered
 * slice of the directory listing, plus a breadcrumb that fits on one line.
 *
 * Pure on purpose — this is the whole of the logic and none of it needs a DOM
 * (`tests/unit/fileListView.test.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHERE THE COST IS — AND SO WHAT "LOAD FIRST 100" MEANS
 * ---------------------------------------------------------------------------
 *
 * It is a RENDER cap, not a fetch limit, and the difference decides the whole
 * design. `api.sftp.list` is one `sftp.readdir` (SftpService.list:96) — the
 * SFTP layer streams the directory to completion inside a single call and
 * hands back the whole array. There is no cursor, no per-entry round trip, and
 * nothing to page: a 4,000-entry folder costs one request whose reply is
 * proportional to N, which on a LAN is milliseconds and on a bad link is one
 * slow reply rather than forty.
 *
 * What is NOT cheap is the other end. Every entry becomes a row with an icon
 * component and three spans, and Vue diffs all of them on every listing
 * change; that is the part that makes a big folder feel bad. So the cap is
 * applied to what we RENDER, the store keeps the full listing it already
 * fetched, and {@link viewFileRows} filters over ALL of it. Searching
 * therefore never needs another round trip and never misses a file just
 * because it sits past the cap — which is the failure mode of capping the
 * fetch instead.
 *
 * (If a host ever does make `readdir` itself slow — a network filesystem, an
 * enormous directory — that is a different fix, in SftpService, and it would
 * need a paging API SFTP's `readdir` does not naturally expose. Nothing here
 * papers over it: the row count shown is the true total.)
 */

/** Rows rendered before "Load more" appears. */
export const FILE_ROW_CAP = 100;

/** The minimum a row must have to be viewed. Keeps this testable with plain objects. */
export interface NamedEntry {
  name: string;
}

export interface FileListView<T extends NamedEntry> {
  /** The rows to render, in the listing's own order. */
  rows: T[];
  /** How many entries survived the filter. */
  total: number;
  /** `total - rows.length`: how many the cap is holding back. */
  hidden: number;
  /** True when a query is narrowing the list. */
  filtered: boolean;
}

/**
 * Case-insensitive substring, and nothing more.
 *
 * Not fuzzy: a fuzzy matcher over a directory of `2026-02-27-*.yaml` files
 * matches essentially everything and ranks by a score the user cannot see,
 * which is worse than the plain answer. A blank query matches everything.
 */
export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q);
}

/**
 * Filter, then cap.
 *
 * That order is the point: filtering the CAPPED slice would search only what
 * you had already scrolled to, which is the most confusing behaviour available
 * — a file you can see in the terminal is simply absent from a search that
 * claims to cover the folder.
 *
 * Ordering is inherited, never re-derived. The store sorts once on load (dirs
 * first, then files, alphabetical — `stores/files.ts` `refresh`), and both the
 * filter and the slice preserve it, so a filtered view is the same list with
 * rows removed rather than a second, differently-ordered list.
 *
 * `..` is deliberately not this function's business. It is navigation, not
 * content, so it lives outside the `v-for` in the template and is therefore
 * never capped away and never filtered away.
 */
export function viewFileRows<T extends NamedEntry>(
  entries: readonly T[],
  options: { query?: string; cap?: number } = {},
): FileListView<T> {
  const query = options.query ?? '';
  const cap = options.cap ?? FILE_ROW_CAP;
  const filtered = query.trim().length > 0;
  const matching = filtered ? entries.filter((e) => matchesQuery(e.name, query)) : [...entries];
  const limit = cap > 0 ? cap : matching.length;
  return {
    rows: matching.slice(0, limit),
    total: matching.length,
    hidden: Math.max(0, matching.length - limit),
    filtered,
  };
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

/** One breadcrumb cell: either a segment you can click, or the gap marker. */
export type Crumb =
  | { kind: 'segment'; name: string; path: string }
  | { kind: 'gap'; hidden: { name: string; path: string }[] };

/**
 * How many trailing segments survive a collapse.
 *
 * Two, plus the root. The root says which machine-relative anchor you are
 * under (`~` or `/`), the last segment is where you ARE, and the one before it
 * is what disambiguates it — the difference between `.../job-market/2026-02-27`
 * and `.../archive/2026-02-27` is entirely in that second-to-last name, and
 * dated or numbered leaf directories (which is what the user's folders look
 * like) are exactly the case where the leaf alone tells you nothing. Three
 * would routinely not fit in a pane that can be dragged down to ~200px.
 */
export const CRUMB_TAIL_SEGMENTS = 2;

/**
 * Turn an absolute path into breadcrumb cells, collapsing the middle once
 * there are more segments than fit on one line.
 *
 * The rule is structural, not measured: the result is never more than four
 * cells. Measuring would let a wide pane show more, at the cost of a layout
 * pass on every navigation and a strip whose contents change when the user
 * drags the splitter — and the pane in question can be dragged narrow, which
 * is where the wrapping showed up in the first place.
 *
 * SEGMENT-level collapsing, not character-level truncation of the whole
 * string: for a path the useful end is the tail, and cutting mid-name produces
 * a crumb that is neither readable nor clickable. `splitLabel` still handles
 * the within-name case (a single very long directory name) in the template —
 * this app has one truncation rule and this is not a second one, it is the
 * layer above it.
 *
 * The hidden segments are carried ON the gap cell rather than thrown away, so
 * the `…` can list them and stay navigable. Losing the ability to click a
 * middle segment is the one thing that would make a breadcrumb not worth
 * having.
 *
 * @param cwd  absolute remote directory
 * @param home the login home, or '' when it is not resolved yet
 */
export function buildCrumbs(
  cwd: string,
  home: string,
  options: { maxSegments?: number; tail?: number } = {},
): Crumb[] {
  const tail = options.tail ?? CRUMB_TAIL_SEGMENTS;
  // Collapse only once collapsing would actually SAVE a cell. At `tail + 1`
  // the strip is at most four cells either way — root + up to three segments,
  // or root + `…` + the two-segment tail — so "one line" is a property of the
  // shape rather than a hope about the width, and a three-deep path is never
  // hollowed out for nothing.
  const maxSegments = options.maxSegments ?? tail + 1;

  // `~` REPLACES the home prefix rather than sitting in front of the absolute
  // spelling of it — otherwise the login home renders as `~ / home / alexey`,
  // the same location said twice with the first copy linking elsewhere.
  const inHome = home !== '' && (cwd === home || cwd.startsWith(home + '/'));
  const root: Crumb = inHome
    ? { kind: 'segment', name: '~', path: home }
    : { kind: 'segment', name: '/', path: '/' };
  const rest = inHome ? cwd.slice(home.length) : cwd;

  const segments: { name: string; path: string }[] = [];
  let acc = inHome ? home : '';
  for (const part of rest.split('/').filter(Boolean)) {
    acc += '/' + part;
    segments.push({ name: part, path: acc });
  }

  if (segments.length <= maxSegments) {
    return [root, ...segments.map((s) => ({ kind: 'segment' as const, ...s }))];
  }
  const kept = segments.slice(-tail);
  const hidden = segments.slice(0, segments.length - tail);
  return [
    root,
    { kind: 'gap', hidden },
    ...kept.map((s) => ({ kind: 'segment' as const, ...s })),
  ];
}
