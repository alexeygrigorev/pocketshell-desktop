/**
 * Pure parsers for the server-side `pocketshell` helper's text/JSON output.
 *
 * Each parser turns raw stdout into typed rows. They are pinned to the
 * fixture strings shipped under tests-docker/fixtures/ (copied from the
 * source repo's tests/docker/agent-fixtures/) so the output contract stays
 * byte-identical to what the real helper emits.
 *
 * All functions are pure: string in, data out, no I/O.
 */

import type { EnvVarRow, SessionAgentKind, SessionSummary } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// `pocketshell sessions list` — fixed-width table
// ---------------------------------------------------------------------------
//
// Shape (from pocketshell-sessions-list.txt / tmuxctl-list.txt):
//
//   IDX  SESSION               CREATED
//   1    claude-main           2026-05-23 10:00:00
//   2    codex                 2026-05-23 09:45:00
//   3    opencode-lab          2026-05-23 09:15:00
//
//   Join a session: pocketshell sessions <id> ...
//
// The anchor is the trailing `YYYY-MM-DD HH:MM:SS` timestamp (issue #200).
// Footer/hint lines and a blank separator are skipped. (Helper 0.4.44 prints
// `tmuxctl <id>` rather than `pocketshell sessions <id>` in those hints — the
// timestamp anchor makes the wording irrelevant.)
//
// The table carries THREE columns and nothing else: there is no cwd, no
// attached flag, no agent kind in it. Those come from the companion tmux
// probe below ({@link SESSION_ENRICHMENT_COMMAND}); the rows this parser
// emits are deliberately bare and get merged with it by the client.

const SESSION_TIMESTAMP_RE = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*$/;

/**
 * Parse `pocketshell sessions list` (or `tmuxctl list`) output.
 * Returns sessions in document order (the helper already sorts by activity
 * when `--by activity` is passed). Unknown/blank output -> empty list.
 */
export function parseSessionsList(stdout: string): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const match = SESSION_TIMESTAMP_RE.exec(line);
    if (!match) continue; // header, footer hints, blank -> skip
    const created = Date.parse(match[1]!);
    if (!Number.isFinite(created)) continue;

    // Everything before the timestamp is `<idx> <session-name>...`. Drop the
    // leading integer index, then the remainder (collapsed) is the name.
    const before = line.slice(0, match.index).trim();
    const idxEnd = before.indexOf(' ');
    const name = (idxEnd >= 0 ? before.slice(idxEnd + 1) : before).trim();
    if (!name) continue;

    out.push({
      name,
      created: Math.floor(created / 1000),
      activity: Math.floor(created / 1000), // created == activity in this shape
      // Filled in from the companion tmux probe — see mergeSessionEnrichment.
      attached: false,
      path: null,
      agentKind: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-session enrichment — the `tmux list-panes -a` companion probe
// ---------------------------------------------------------------------------
//
// `pocketshell sessions list` prints IDX/SESSION/CREATED and nothing more, so
// on its own it cannot answer the three questions the folder-grouped session
// list asks of every row: *where* is this session, is it *attached*, and *what
// is running* in it. The phone answers all three from tmux directly
// (`FolderListGateway.LIST_SESSIONS_COMMAND` / `LIST_PANES_COMMAND`,
// FolderListGateway.kt:2109-2124) and we mirror that here.
//
// One probe, not two, and not one-per-session: tmux resolves SESSION-scoped
// formats (`session_path`, `session_attached`, and session user options like
// `@ps_agent_kind`) inside a PANE-scoped `list-panes` context, because the
// pane's session is in its format tree. So a single `list-panes -a` yields
// both halves of what the phone fetches with two commands. Verified against
// tmux 3.4 (the user's box) and tmux 3.6b (the helper fixture image).
//
// Field order deliberately puts `pane_current_path` and `session_path` before
// the remaining scalar fields — see FIELD_SEP note below.

/** The `::` delimiter, matching the phone's `FolderListGateway.FIELD_SEP`. */
const FIELD_SEP = '::';

/**
 * The single companion probe run alongside `pocketshell sessions list`.
 *
 * `tmux -u` (issue #2160): a tmux client without a UTF-8 locale sanitises
 * every non-ASCII byte it prints to `_`, which would corrupt paths and
 * recorded option values on hosts whose sshd exports no locale.
 *
 * Column order is `name, window_active, pane_active, pane_current_path,
 * session_path, session_attached, @ps_agent_kind, socket_path`. Paths sit in
 * the middle rather than last (the phone parks `session_path` last for the
 * same reason) because a `::` inside a path would otherwise swallow the
 * fields after it — here the parser splits a FIXED count of fields, so only
 * the two path columns can be ambiguous and the scalar tail is always
 * recoverable.
 *
 * `socket_path` is the newest column and the reason aimed actions (Stop,
 * rename) can be aimed at all: the ecosystem now runs one tmux SERVER per
 * session, so two sessions can share a name legally and a bare `tmux` sees
 * only the legacy default one. The parser reads the socket from the same
 * positional end as the other scalars, and an old probe that lacks the
 * column simply yields null there — see {@link SessionEnrichment.socketPath}.
 *
 * That reasoning holds, but only if the parser actually splits from BOTH
 * ends, which it did not: it took the first seven fields left to right, so a
 * `::` in a path shifted `session_attached` and `@ps_agent_kind` one place
 * left and both were read out of a path fragment. {@link splitEnrichmentRow}
 * takes the three leading scalars and the two trailing ones by position from
 * their own end, which is what makes the tail genuinely recoverable.
 */
const ENRICHMENT_FORMAT =
  `#{session_name}${FIELD_SEP}#{window_active}${FIELD_SEP}#{pane_active}${FIELD_SEP}` +
  `#{pane_current_path}${FIELD_SEP}#{session_path}${FIELD_SEP}#{session_attached}` +
  `${FIELD_SEP}#{@ps_agent_kind}${FIELD_SEP}#{socket_path}`;

export const SESSION_ENRICHMENT_COMMAND =
  `tmux -u list-panes -a -F '${ENRICHMENT_FORMAT}' 2>/dev/null; ` +
  // Every OTHER tmux server this user has, not only the default one.
  //
  // `list-panes -a` is per-SERVER, and that is the half of this probe the
  // three previous attempts at the missing-directory bug never questioned. The
  // user's log has `pocketshell sessions list` returning twelve sessions while
  // this probe produced rows for eight, with `unmatchedProbeKeys` empty — so it
  // was not a spelling mismatch and not a parse failure, it was four sessions
  // this command could not see. Measured against real tmux 3.4, `list-panes -a`
  // omits nothing on the server it reaches, so the four were not on that
  // server. The same log says so from a second direction: raw `tmux` on that
  // connection answered `can't find session:` for three of those exact four.
  //
  // The note on `sessionAttachCommand` says tmuxctl shells out to a bare `tmux`
  // with no `-L`/`-S`, so there SHOULD be one socket. That was reasoned from a
  // host inspection, not from this host, and it is exactly the kind of
  // assumption that survives three fixes. Sweeping the socket directory costs
  // one shell loop and removes the assumption instead of restating it.
  //
  // The default invocation above is kept and run FIRST rather than being
  // replaced by the sweep: a host whose `TMUX_TMPDIR` points somewhere this
  // glob does not model would otherwise go from eight rows to zero. Duplicate
  // rows for the default socket are free — {@link parseSessionEnrichment} keys
  // by session name, so the second reading of a session overwrites the first
  // with itself.
  //
  // Stale sockets whose server has died print `no server running` to stderr and
  // exit 1; `2>/dev/null` and the loop's own continuation absorb both.
  'for __ps_s in "${TMUX_TMPDIR:-/tmp}"/tmux-$(id -u)/*; do ' +
  '[ -S "$__ps_s" ] || continue; ' +
  `tmux -S "$__ps_s" -u list-panes -a -F '${ENRICHMENT_FORMAT}' 2>/dev/null; ` +
  'done';

/**
 * A per-session `socket_path` / `pid` reading, for the log only.
 *
 * Run ONLY when something came back unplaced, because it answers a question
 * nobody has on a healthy host: are these sessions on the server we think they
 * are on? Two sessions reporting different `#{pid}` values is a second tmux
 * server, full stop, and a session the helper lists that appears in NO row here
 * does not exist on any socket we can see — which are the two remaining
 * explanations for the user's report and are indistinguishable in the UI.
 */
export const SESSION_SOCKET_DIAGNOSTIC_COMMAND =
  `tmux -u list-panes -a -F '#{session_name}${FIELD_SEP}#{socket_path}${FIELD_SEP}#{pid}' 2>/dev/null; ` +
  'for __ps_s in "${TMUX_TMPDIR:-/tmp}"/tmux-$(id -u)/*; do ' +
  '[ -S "$__ps_s" ] || continue; ' +
  `tmux -S "$__ps_s" -u list-panes -a -F '#{session_name}${FIELD_SEP}#{socket_path}${FIELD_SEP}#{pid}' 2>/dev/null; ` +
  'done';

/** What the companion probe adds to a bare `sessions list` row. */
export interface SessionEnrichment {
  /** Active pane's cwd, falling back to `session_path`; null if neither. */
  path: string | null;
  attached: boolean;
  agentKind: SessionAgentKind | null;
  /**
   * The tmux server this session lives on, verbatim from `#{socket_path}`.
   *
   * The helper's ecosystem now runs one tmux SERVER per session (sockets
   * `tmuxctl-*` beside the legacy shared one — see the doc block on
   * `sessionExistsCommand`), so a name alone no longer says where a kill or a
   * rename must be aimed. Null when the probe's tmux predates the column or
   * the field came back empty; the caller then falls back to the bare,
   * default-socket commands.
   */
  socketPath: string | null;
}

/**
 * Map a raw host-side `@ps_agent_kind` value to a {@link SessionAgentKind}.
 *
 * The exact inverse of the helper's `record_agent_kind` write
 * (`tmux set-option @ps_agent_kind <kind>`, agents.py:419) and a direct port
 * of the phone's `sessionAgentKindFromOption`
 * (shared/ui-kit/.../SessionAgentKind.kt:97).
 *
 * Returns null for a blank option (a session we did not launch) AND for an
 * unrecognised one — the user's box really does carry values like
 * `test-engine` — so an unknown string falls back to "we don't know" rather
 * than mislabeling the row. `probing` / `exited` are never recorded and so
 * never appear here.
 */
export function agentKindFromTmuxOption(raw: string | null | undefined): SessionAgentKind | null {
  switch (raw?.trim().toLowerCase()) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
    case 'grok':
      return 'grok';
    case 'shell':
      return 'shell';
    default:
      return null;
  }
}

/**
 * Parse {@link SESSION_ENRICHMENT_COMMAND} output into a per-session map.
 *
 * cwd precedence is the phone's (FolderListGateway.kt:1085-1089): the ACTIVE
 * pane of the ACTIVE window wins, `session_path` is the fallback. A session
 * whose active pane has `cd`'d away should group where the user actually is,
 * and `session_path` can even be a literal unexpanded `~/git` on a session
 * created with a tilde cwd — which would otherwise become its own bogus
 * folder, since path canonicalisation deliberately never expands `~`.
 */
export function parseSessionEnrichment(stdout: string): Map<string, SessionEnrichment> {
  const out = new Map<string, SessionEnrichment>();
  /** Sessions whose active-pane row we have already seen (it wins outright). */
  const activeSeen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const row = splitEnrichmentRow(rawLine);
    if (!row) continue;
    const { name, windowActive, paneActive, panePath, sessionPath, attached, kind, socketPath } =
      row;

    const isActive = windowActive === '1' && paneActive === '1';
    if (activeSeen.has(name) && !isActive) continue;
    const path = (isActive ? panePath : '') || sessionPath || '';
    const attachedCount = Number.parseInt(attached, 10);
    out.set(name, {
      path: path ? path : null,
      attached: Number.isFinite(attachedCount) && attachedCount > 0,
      agentKind: agentKindFromTmuxOption(kind),
      socketPath: socketPath ? socketPath : null,
    });
    if (isActive) activeSeen.add(name);
  }
  return out;
}

/** One row of {@link SESSION_ENRICHMENT_COMMAND}, already de-shifted. */
interface EnrichmentRow {
  name: string;
  windowActive: string;
  paneActive: string;
  panePath: string;
  sessionPath: string;
  attached: string;
  kind: string;
  socketPath: string;
}

/**
 * Split one probe line into its fields, tolerating both of the shapes the
 * the old fixed left-to-right split got wrong.
 *
 * ## Too many fields
 *
 * A `::` inside either path column produces MORE than the seven parts a
 * socket-less row has (eight once the socket column is present). Reading
 * the first seven then shifted `session_attached` and `@ps_agent_kind` out of
 * a path fragment, which quietly reported the session as detached and
 * agent-less. Only the two path columns are ambiguous, so the three leading
 * scalars are taken from the front, the trailing ones from the back, and
 * whatever is left in the middle is the two paths.
 *
 * Splitting that middle is the one genuinely ambiguous decision here, and it
 * is resolved by what the two columns MEAN rather than by counting: the
 * session's path is the directory the session was created in and the pane's
 * is where its shell is now, so the former is almost always an ancestor of
 * (or equal to) the latter. When more than one `::` sits in the middle we
 * take the split that satisfies that relationship, and fall back to the first
 * `::` when none does — which is the old behaviour, so the common case is
 * unchanged.
 *
 * ## Too few fields
 *
 * `parts.length < 7` used to drop the line outright, which is the wrong
 * default for a probe whose whole contract is "degrade, never cost us the
 * row". A tmux too old to expand `#{@ps_agent_kind}` emits the literal text
 * rather than an empty field, and a genuinely truncated line (an SSH read cut
 * short) loses its TAIL, not its head — so a row that has at least the name
 * and the two active flags still tells us where the session is. Missing
 * trailing fields are treated as empty; a row with fewer than five fields
 * carries no path at all and is still skipped, along with header noise and
 * "no server running".
 */
function splitEnrichmentRow(rawLine: string): EnrichmentRow | null {
  const line = rawLine.trim();
  if (!line) return null;
  const parts = line.split(FIELD_SEP);
  // Below five there is no path column to read, so the row cannot do the one
  // job it exists for. This is also what skips "no server running" and any
  // banner a login shell printed before the probe's own output.
  if (parts.length < 5) return null;

  const name = (parts[0] ?? '').trim();
  if (!name) return null;
  const windowActive = parts[1] ?? '';
  const paneActive = parts[2] ?? '';

  // Trailing fields are counted from the END so a `::` in a path cannot shift
  // them. The socket column arrived LAST and is optional: a probe from before
  // it was added simply produces one fewer field, and empty is the right
  // reading of both that and a blank value ("aim at the default server").
  //
  // Which tail shape a row has is decided by what the last field IS, not by
  // how many fields there are — because a hostile path adds a part to BOTH
  // shapes alike. A socket is an absolute tmux socket path; the two scalars
  // beside it never look like one (`session_attached` is a digit, the agent
  // word is an engine name or blank). So a last field starting with `/` is a
  // socket, and anything else is a legacy row whose path grew the extra part,
  // which then reads with exactly the pre-socket tail logic. The one row this
  // can misread — new format, genuinely empty socket, hostile path — keeps its
  // row and loses its path, which is the pre-socket behaviour anyway.
  const n = parts.length;
  const hasSocket = n >= 8 && (parts[n - 1] ?? '').startsWith('/');

  if (hasSocket) {
    const socketPath = parts[n - 1] ?? '';
    const kind = parts[n - 2] ?? '';
    const attached = parts[n - 3] ?? '';
    const [panePath, sessionPath] = splitPathPair(parts.slice(3, n - 3));
    return { name, windowActive, paneActive, panePath, sessionPath, attached, kind, socketPath };
  }

  // The tail is taken from the END so a `::` in a path cannot shift it. When
  // the row is short the tail fields simply are not there, and empty is the
  // right reading of both: no attach count means "not attached", no recorded
  // option means "we did not launch this".
  const hasKind = n >= 7;
  const hasAttached = n >= 6;
  const kind = hasKind ? (parts[parts.length - 1] ?? '') : '';
  const attached = hasAttached ? (parts[parts.length - (hasKind ? 2 : 1)] ?? '') : '';

  const middleEnd = parts.length - (hasKind ? 2 : hasAttached ? 1 : 0);
  const middle = parts.slice(3, middleEnd);
  const [panePath, sessionPath] = splitPathPair(middle);

  return { name, windowActive, paneActive, panePath, sessionPath, attached, kind, socketPath: '' };
}

/**
 * Recover `pane_current_path` and `session_path` from the middle fields.
 *
 * The normal case is exactly two entries and no decision to make. See
 * {@link splitEnrichmentRow} for why the ancestor relationship is the
 * tie-break when a path contained the delimiter.
 */
function splitPathPair(middle: string[]): [string, string] {
  if (middle.length === 0) return ['', ''];
  if (middle.length === 1) return [middle[0] ?? '', ''];
  if (middle.length === 2) return [middle[0] ?? '', middle[1] ?? ''];
  for (let cut = 1; cut < middle.length; cut++) {
    const pane = middle.slice(0, cut).join(FIELD_SEP);
    const session = middle.slice(cut).join(FIELD_SEP);
    if (pane === session || pane.startsWith(session.endsWith('/') ? session : session + '/')) {
      return [pane, session];
    }
  }
  return [middle[0] ?? '', middle.slice(1).join(FIELD_SEP)];
}

/**
 * Fold the companion probe's data into the bare rows from `sessions list`.
 *
 * A session with no enrichment entry keeps its bare defaults — the probe
 * degrading (no tmux, non-zero exit, a tmux too old for `#{@…}`) must never
 * cost us the list itself, only the grouping metadata.
 */
/**
 * Put back the sessions the helper's table omitted but the enrichment probe
 * SAW.
 *
 * ## Why this exists
 *
 * The table and the probe travel in the same round-trip but are independent
 * reads: the table is one CLI pass over every socket, the probe its own
 * sweep. On a loaded host the table can come back TRUNCATED — one socket's
 * rows missing while the probe saw them fine — and a table that merely
 * forgot a live session was being accepted as the whole truth, which pruned
 * the session's tab, closed its pane, and made a running session
 * un-openable until a luckier poll (measured on CI: tab bar held
 * `build` while the host sweep answered `main attached=1` and the
 * helper's own list named both).
 *
 * A session the probe saw is live — the same evidence the Stop locator
 * trusts — so the omission is repaired from the probe's rows. Timestamps
 * are the one thing the probe does not carry, so a restored row reports 0
 * for created/activity (it sorts last, it does not lie) and the next
 * complete poll replaces it wholesale.
 */
/**
 * Reuse the last reported working directory for a session whose placement
 * evidence dropped out of THIS poll.
 *
 * A session's folder placement rests entirely on the enrichment probe: the
 * helper's table carries names and times but no paths. When that probe has a
 * bad round trip — measured flapping on CI (`tmux -u list-panes -a` exiting 1
 * while the session sat alive and attached on the host) — every path-bearing
 * row vanishes at once, and a session with no path has nowhere to live: its
 * folder's tab bar prunes it, its pane closes, and a running agent becomes
 * un-openable until a luckier poll. The cache is the answer the same problem
 * already got for repository roots: a directory a session was in does not
 * stop being true because one read of it failed.
 *
 * Pure: [cache] maps session name to last reported path and is UPDATED in
 * place (new evidence overwrites, absence never deletes). Returns the list
 * with nulls filled from the cache where one exists, flagged via
 * `pathInferred` so the UI can say the placement is remembered, not read.
 */
export function applyCachedSessionPaths(
  sessions: SessionSummary[],
  cache: Map<string, string>,
): SessionSummary[] {
  for (const session of sessions) {
    if (typeof session.path === 'string' && session.path.length > 0) {
      cache.set(session.name, session.path);
    }
  }
  let changed = false;
  const out = sessions.map((session) => {
    if (session.path !== null) return session;
    const cached = cache.get(session.name);
    if (cached === undefined) return session;
    changed = true;
    return { ...session, path: cached, pathInferred: true };
  });
  return changed ? out : sessions;
}

export function restoreUnlistedSessions(
  sessions: SessionSummary[],
  enrichment: Map<string, SessionEnrichment>,
): SessionSummary[] {
  if (enrichment.size === 0) return sessions;
  const listed = new Set(sessions.map((session) => session.name));
  const restored: SessionSummary[] = [];
  for (const [name, extra] of enrichment) {
    if (listed.has(name)) continue;
    restored.push({
      name,
      created: 0,
      activity: 0,
      attached: extra.attached,
      path: extra.path ?? null,
      agentKind: extra.agentKind,
    });
  }
  if (restored.length === 0) return sessions;
  return [...sessions, ...restored];
}

export function mergeSessionEnrichment(
  sessions: SessionSummary[],
  enrichment: Map<string, SessionEnrichment>,
): SessionSummary[] {
  const merged = sessions.map((session) => {
    const extra = findEnrichment(enrichment, session.name);
    if (!extra) return session;
    return {
      ...session,
      // The pane probe's cwd is the better answer, but never downgrade a path
      // the fallback path already resolved to null.
      path: extra.path ?? session.path,
      attached: extra.attached,
      agentKind: extra.agentKind,
    };
  });
  return inferPathsFromSiblings(merged);
}

/**
 * Give a session with no reported working directory the directory of the
 * session it is named after.
 *
 * ## Why this exists
 *
 * The user reported four sessions rendering as orphans - direct children of a
 * root with no folder - and circled two pairs they expected to sit together:
 * `git-red-stamp-sound` against `git-red-stamp`, and `git-dtc-website-import`
 * against `git-dtc-website`. In every pair the orphan's name is the other
 * session's name plus a `-suffix`, which is exactly what a second session in
 * one folder is called.
 *
 * It matters more than it used to. The folder workspace keys EVERYTHING on the
 * folder - one panel row per folder, one workspace per folder, tabs derived
 * from the sessions in it - so a session with no folder has nowhere to live at
 * all. Leaving it unplaced is not an annoyance any more; it is a live session
 * the user can no longer reach.
 *
 * ## Why it matches against siblings rather than deriving a path from the name
 *
 * `rootFromSessionName` (src/renderer/sessionGrouping.ts) recovers only the
 * ROOT from a name, and its comment explains the refusal to go further: `-` is
 * both the component separator AND a legal character inside a component, so
 * `git-dtc-website-import` is genuinely ambiguous between
 * `~/git/dtc-website-import` and `~/git/dtc-website/import`, and inventing a
 * folder from that guess is worse than having none.
 *
 * This does not guess. It only ever adopts a path that ANOTHER SESSION IS
 * ACTUALLY REPORTING, so it can file a session into a folder that exists and
 * can never conjure one that does not. The longest matching prefix wins, so a
 * host running both `git-a` and `git-a-b` places `git-a-b-c` under `git-a-b`.
 *
 * ## When it is wrong, and why it is still worth doing
 *
 * If `git-red-stamp-sound` genuinely runs in `~/git/red-stamp-sound` - its own
 * repo - this files it under `~/git/red-stamp`, and the real fix is the null
 * path rather than the grouping. The rows are marked `pathInferred` so the
 * guess is legible rather than silent, and {@link diagnoseSessionPaths} is what
 * settles which case a host is in. The alternative is leaving the session in
 * the bucket the user has just complained about.
 *
 * Sessions that already have a path are returned untouched, and a session with
 * no matching sibling keeps its null.
 */
export function inferPathsFromSiblings(sessions: SessionSummary[]): SessionSummary[] {
  const anchors = sessions.filter((s) => s.path != null && s.path !== '');
  if (anchors.length === 0) return sessions;
  return sessions.map((session) => {
    if (session.path != null && session.path !== '') return session;
    let best: SessionSummary | null = null;
    for (const anchor of anchors) {
      // The `-` boundary is required for the same reason the tab-label
      // stripper requires it: `git-red-stamp` must not claim
      // `git-red-stampede`, which is a different folder entirely.
      if (!session.name.startsWith(`${anchor.name}-`)) continue;
      if (best === null || anchor.name.length > best.name.length) best = anchor;
    }
    if (best === null) return session;
    return { ...session, path: best.path, pathInferred: true };
  });
}

/**
 * What went wrong for every session that still has no working directory of its
 * own.
 *
 * A pure function, so the diagnosis is testable; `PocketshellClient.listSessions`
 * calls it and writes the result to `~/.pocketshell/desktop.log` (see
 * src/main/log.ts for why a file log exists at all). The point is to replace a
 * guess with an observation: the three candidate causes below produce an
 * identical symptom in the UI - a session in the wrong place - and are told
 * apart only by what the probe actually said.
 *
 *   absent     the probe emitted no row for this session under any spelling.
 *              Either tmux listed no panes for it, or the probe output was cut
 *              short.
 *   no-path    a row was there and both path columns were empty. That is what
 *              tmux reports for a pane whose process has exited under
 *              `remain-on-exit`.
 *   ambiguous  a row exists under a different spelling, but the
 *              column-sanitised key it would have been found by was claimed by
 *              two sessions and dropped by 3ac7abc's safety rule.
 *
 * `unmatchedProbeKeys` is the other half of the picture: enrichment rows that
 * matched no listed session at all. A spelling mismatch the sanitiser does not
 * model shows up there and nowhere else.
 */
export interface SessionPathDiagnosis {
  name: string;
  probe: 'absent' | 'no-path' | 'ambiguous';
  /** The column-sanitised key the lenient lookup would have used. */
  lenientKey: string;
  /** True when the path this session ended up with came from a sibling. */
  inferred: boolean;
}

export interface SessionPathReport {
  total: number;
  /** Sessions the probe failed to place - inferred ones included. */
  unplaced: SessionPathDiagnosis[];
  /** Probe rows that belong to no listed session. */
  unmatchedProbeKeys: string[];
}

export function diagnoseSessionPaths(
  sessions: SessionSummary[],
  enrichment: Map<string, SessionEnrichment>,
): SessionPathReport {
  const { index: lenient, ambiguous } = lenientEnrichmentIndex(enrichment);
  const matched = new Set<string>();
  const unplaced: SessionPathDiagnosis[] = [];

  for (const session of sessions) {
    const lenientKey = asciiSanitised(session.name);
    const exact = enrichment.get(session.name);
    const loose = exact ?? lenient.get(lenientKey);
    if (exact) matched.add(session.name);

    // `pathInferred` means the path on the row is a SIBLING's, so the probe
    // still failed to place this session - which is what this report is about.
    // A row carrying a path of its own is simply fine.
    const placed = session.path != null && session.path !== '' && session.pathInferred !== true;
    if (placed) continue;

    const probe: SessionPathDiagnosis['probe'] = loose
      ? 'no-path'
      : ambiguous.has(lenientKey)
        ? 'ambiguous'
        : 'absent';
    unplaced.push({
      name: session.name,
      probe,
      lenientKey,
      inferred: session.pathInferred === true,
    });
  }

  const unmatchedProbeKeys = [...enrichment.keys()].filter((key) => !matched.has(key));
  return { total: sessions.length, unplaced, unmatchedProbeKeys };
}

/**
 * Why the two halves of this join can disagree about a session's NAME.
 *
 * The names come from `pocketshell sessions list`, which shells out to
 * `tmuxctl list`, which runs plain `tmux list-sessions`. The paths come from
 * our own probe, which runs `tmux -u list-panes -a`. Same host, same tmux
 * server, two different tmux CLIENTS — and a tmux client that has not been
 * told it is on a UTF-8 terminal SANITISES every byte it prints, replacing
 * each one outside ASCII with a single `_`. Captured on the fixture image
 * (tmux 3.4, sshd exporting no locale), for a session named `git-café-guide`:
 *
 *   $ tmux list-sessions -F '#{session_name}'
 *   git-caf_-guide
 *   $ tmux -u list-panes -a -F '#{session_name}::…'
 *   git-café-guide::…
 *
 * `-u` was added to the probe (issue #2160) so that PATHS survived exactly
 * this mangling. What it also did, unnoticed, was move one side of the join
 * key out of step with the other: the helper offers `git-caf_-guide`, the
 * probe is filed under `git-café-guide`, `Map.get` misses, and the session
 * keeps the `path: null` that `parseSessionsList` gave it. The row still
 * lists — it just has no working directory, so the Files tab opens at the
 * login home and the folder panel files it under `other`.
 *
 * Dropping `-u` would trade a broken name for a broken path and fix nothing.
 * Matching leniently costs one extra index and fixes both: look the exact
 * name up first, and only if that misses, look up the name with the same
 * sanitisation the un-`-u`'d client would have applied.
 *
 * Control bytes are folded too, because the same client applies the same
 * treatment to them — that is what breaks tmuxctl's own tab-delimited
 * `list-sessions` on this fixture (tmuxctl issue #6).
 *
 * The substitution is per DISPLAY COLUMN, not per byte and not per character,
 * which is worth stating because two of the three are wrong. Measured on the
 * same image:
 *
 *   git-café-guide  ->  git-caf_-guide     (1 char, 2 bytes, 1 column)
 *   git-ćé-x        ->  git-__-x           (2 chars, 4 bytes, 2 columns)
 *   git-日本-y       ->  git-____-y         (2 chars, 6 bytes, 4 columns)
 *
 * So a CJK or emoji character costs two underscores and a Latin accent one.
 * {@link displayColumns} models that; it does not have to be a complete
 * wcwidth, because a name this gets wrong simply fails to match and keeps
 * today's null path rather than acquiring a wrong one.
 */
function asciiSanitised(name: string): string {
  let out = '';
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    out += cp >= 0x20 && cp < 0x7f ? ch : '_'.repeat(displayColumns(cp));
  }
  return out;
}

/**
 * Terminal columns one code point occupies — enough of wcwidth to cover what
 * turns up in a session name, which is a directory basename.
 *
 * The wide ranges are the East Asian Wide/Fullwidth blocks plus the emoji
 * planes; everything else, control characters included, is one column.
 */
function displayColumns(cp: number): number {
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals .. Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd); // CJK extension planes
  return wide ? 2 : 1;
}

/**
 * Secondary index for {@link mergeSessionEnrichment}, keyed by the sanitised
 * name.
 *
 * A key that two different sessions sanitise to is DROPPED rather than
 * resolved arbitrarily. Attaching one session's working directory to another
 * is a worse outcome than the missing path this is here to fix: a null path
 * shows up as a session in the `other` bucket, while a wrong one silently
 * opens the Files tab in someone else's project.
 */
function lenientEnrichmentIndex(enrichment: Map<string, SessionEnrichment>): {
  index: Map<string, SessionEnrichment>;
  /** Keys two sessions both claimed, and which were therefore dropped. */
  ambiguous: Set<string>;
} {
  const index = new Map<string, SessionEnrichment>();
  const ambiguous = new Set<string>();
  for (const [name, value] of enrichment) {
    const key = asciiSanitised(name);
    if (key === name) continue; // the exact lookup already covers it
    if (index.has(key)) {
      ambiguous.add(key);
      continue;
    }
    index.set(key, value);
  }
  for (const key of ambiguous) index.delete(key);
  return { index, ambiguous };
}

/**
 * Look a session name up in the enrichment map exactly, then — and only then —
 * under the ASCII sanitisation a non-`-u` tmux client would have printed
 * ({@link asciiSanitised}).
 *
 * One function because the exact-then-lenient ORDER is load-bearing in more
 * than one caller now: {@link mergeSessionEnrichment} joins paths with it and
 * {@link PocketshellClient.locateSession} turns it into an aimed kill. A
 * caller inlining the two lookups is how the order drifts.
 */
export function findEnrichment(
  enrichment: Map<string, SessionEnrichment>,
  name: string,
): SessionEnrichment | null {
  const exact = enrichment.get(name);
  if (exact) return exact;
  const lenient = lenientEnrichmentIndex(enrichment).index.get(asciiSanitised(name));
  return lenient ?? null;
}

/**
 * Parse the `tmux list-sessions -F` fallback (`::`-delimited):
 *   session_name::created_epoch::activity_epoch::attached_count[:path]
 */
export function parseTmuxListSessionsFallback(stdout: string): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('no server')) continue;
    const parts = line.split('::');
    const [name, created, activity, attached, path] = parts;
    if (!name || created === undefined || activity === undefined) continue;
    const createdNum = Number.parseInt(created, 10);
    const activityNum = Number.parseInt(activity, 10);
    const attachedNum = attached === undefined ? NaN : Number.parseInt(attached, 10);
    if (!name || !Number.isFinite(createdNum)) continue;
    out.push({
      name,
      created: createdNum,
      activity: Number.isFinite(activityNum) ? activityNum : createdNum,
      attached: Number.isFinite(attachedNum) && attachedNum > 0,
      path: path && path !== '' ? path : null,
      // This shape carries no `@ps_agent_kind`; the companion probe supplies it.
      agentKind: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// `pocketshell usage --json` — NDJSON rows
// ---------------------------------------------------------------------------

/**
 * One quota window. `percent_remaining` is NULLABLE on helper 0.4.44: a
 * provider with no short-term window at all (codex, grok) emits
 * `{"percent_remaining": null, "reset_at": null, "window": null}` rather than
 * omitting the object. Callers must guard before formatting it.
 */
export interface UsageWindow {
  percent_remaining: number | null;
  reset_at: string | null;
  /**
   * Window label, e.g. `5h` / `7d` / `weekly` / `monthly`. Always present on
   * 0.4.44 — null when the provider has no window of that term, never absent
   * (see v0.4.44-usage.ndjson, where codex and copilot carry an explicit
   * `"window": null`).
   */
  window: string | null;
}

export interface UsageRow {
  provider: string;
  // `string & {}` keeps the documented literals visible to narrowing and
  // autocomplete while still accepting values a newer helper may add. A bare
  // `| string` would absorb the literals and enforce nothing.
  status: 'ok' | 'limited' | 'blocked' | 'error' | (string & {});
  short_term: UsageWindow;
  long_term: UsageWindow;
  error: string | null;
  details: Record<string, unknown>;
  /**
   * The raw per-window map the installed helper actually emits (`5h`, `7d`,
   * `weekly`, `monthly`, `short_term` — keys, not a fixed pair). Only
   * `parseUsageNdjson` reads it, folding it into `short_term`/`long_term`
   * below; kept on the type so the parser's cast is honest about the wire.
   */
  windows?: Record<string, Partial<UsageWindow> | undefined>;
}

/**
 * Which slot a `windows` key feeds. The observed keys and the fallback rule
 * both come from host captures (v0.4.44-usage-windows.ndjson): copilot's map
 * carries a literal `short_term`, zai's a `5h`+`weekly` pair, grok's a lone
 * `weekly`. An unrecognized key fills whichever slot is still empty, so a
 * future label degrades to the wrong column rather than vanishing.
 */
const SHORT_TERM_WINDOW_KEYS = new Set(['5h', 'short_term']);
const LONG_TERM_WINDOW_KEYS = new Set(['7d', 'weekly', 'monthly', 'long_term']);

/** The shape a 0.4.44 row already used for "no window in this band". */
const EMPTY_WINDOW: UsageWindow = { percent_remaining: null, reset_at: null, window: null };

/**
 * Rebuild `short_term`/`long_term` from a `windows` map. The helper still
 * self-reports 0.4.44 while quse's record underneath it moved from the
 * top-level pair to a keyed map, and a
 * row consumed raw has no `short_term` at all — a consumer that indexes it
 * throws. Rows already carrying the pair pass through untouched; a slot the
 * map says nothing about becomes the explicit-nulls EMPTY_WINDOW.
 */
function normalizeUsageRow(row: UsageRow): UsageRow {
  if (row.short_term || row.long_term) return row;
  const windows = row.windows;
  if (!windows || typeof windows !== 'object') return row;
  let short_term: UsageWindow | null = null;
  let long_term: UsageWindow | null = null;
  for (const [key, w] of Object.entries(windows)) {
    if (!w || typeof w !== 'object') continue;
    const win: UsageWindow = {
      percent_remaining: typeof w.percent_remaining === 'number' ? w.percent_remaining : null,
      reset_at: typeof w.reset_at === 'string' ? w.reset_at : null,
      // The key is the human label (`5h`, `7d`) — except when it is the slot's
      // own name, which reads as "short_term" on screen. Null sends those to
      // the consumer's generic short-term/long-term wording instead.
      window: key === 'short_term' || key === 'long_term' ? null : key,
    };
    if (!short_term && SHORT_TERM_WINDOW_KEYS.has(key)) short_term = win;
    else if (!long_term && LONG_TERM_WINDOW_KEYS.has(key)) long_term = win;
    else if (!short_term) short_term = win;
    else if (!long_term) long_term = win;
  }
  return { ...row, short_term: short_term ?? EMPTY_WINDOW, long_term: long_term ?? EMPTY_WINDOW };
}

/** Parse `pocketshell usage --json` (one JSON object per line). */
export function parseUsageNdjson(stdout: string): UsageRow[] {
  const out: UsageRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(normalizeUsageRow(JSON.parse(trimmed) as UsageRow));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// bootstrap probe result parsing
// ---------------------------------------------------------------------------

/**
 * Parse `command -v <binary>` output into an absolute path, or null if the
 * binary is absent. The probe is run as `command -v pocketshell`; exit 0 +
 * non-empty stdout means installed, anything else means missing.
 */
export function parseCommandV(stdout: string, exitCode: number): string | null {
  if (exitCode !== 0) return null;
  const path = stdout.trim().split(/\r?\n/)[0];
  return path && path.length > 0 ? path : null;
}

/**
 * The subcommand names in the `Commands:` block of a click `--help`, or null
 * when the output could not be read that way.
 *
 * Written for `pocketshell agent --help`, which is how the app finds out
 * whether a host can launch a given engine. Asking the help text rather than
 * comparing `pocketshell --version` against a remembered table is the same
 * choice made everywhere else in this file: the helper is a separately
 * released project, this repo has been wrong about its documented contract
 * repeatedly, and the `Commands:` block is the host stating its own
 * capabilities in its own words. It also degrades honestly — a helper that
 * gains `grok` starts being offered the moment it is installed, with no
 * version table to bump here.
 *
 * The shape it parses, from `tests/unit/fixtures/v0.4.44-agent-help.txt`:
 *
 *     Commands:
 *       claude    Launch `claude` in --dir with first-run prompts suppressed.
 *       codex     Launch `codex` in --dir with first-run prompts suppressed.
 *       opencode  Launch `opencode` in --dir with first-run prompts suppressed.
 *
 * Names sit at exactly two spaces of indent; click wraps a long description
 * onto continuation lines indented to the description column, so an indented
 * line that does not start a name is SKIPPED rather than treated as the end of
 * the block. A non-indented line is a new section and does end it.
 *
 * **null, never `[]`, when the answer is unknown** — a non-zero exit, no
 * `Commands:` header, or a header with nothing parseable under it. Callers act
 * on the difference: `[]` would be a host claiming it can launch nothing,
 * which no real helper says, whereas null means we never got an answer and the
 * caller should fall back to what the pinned version guarantees rather than to
 * refusing everything. See shared/agentLaunch.ts `HostAgentSupport`.
 */
export function parseAgentSubcommands(stdout: string, exitCode: number): string[] | null {
  if (exitCode !== 0) return null;
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => /^Commands:\s*$/.test(line));
  if (start < 0) return null;
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    // Back at the left margin: a new `--help` section, so the block is over.
    if (!/^\s/.test(line)) break;
    const match = /^ {2}(\S+)(?: {2,}\S|\s*$)/.exec(line);
    if (match) names.push(match[1]!);
  }
  return names.length > 0 ? names : null;
}

/**
 * One row of `pocketshell env list --json`, or undefined when the row does not
 * have the shape the helper promises.
 *
 * `env list` is the env editor's SOURCE OF KEY NAMES (FEATURES.md F16), and
 * the panel renders whatever this returns — so a row missing `key`, or
 * carrying a number where the file name belongs, is dropped here rather than
 * smuggled into a list of strings downstream. Values are deliberately absent
 * from the shape: the helper's write-only default keeps them off the wire
 * until `env get --key` names them one by one (ANALYSIS.md D24).
 */
export function parseEnvVarRow(row: unknown): EnvVarRow | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const doc = row as Record<string, unknown>;
  if (typeof doc['key'] !== 'string' || doc['key'].length === 0) return undefined;
  return {
    file: typeof doc['file'] === 'string' ? doc['file'] : '',
    hasValue: doc['has_value'] === true,
    key: doc['key'],
  };
}

/**
 * One node of the host's durable project-tree registry
 * (`pocketshell tree get`, FEATURES.md F18's successor item: the
 * session-to-folder record the phone keeps and the desktop never called).
 */
export interface TreeNodeRecord {
  session: string;
  order: number;
  folderPath: string;
  collapsed: boolean;
}

/**
 * Parse a `tree get` response: `{"nodes": [...], "version": N}`.
 *
 * **null, never [], when the payload is not a tree answer at all** — a proxy
 * banner, a truncated body, a wrong-version helper. The caller treats null as
 * "no registry" and falls back to the name heuristic, while a real `[]` is a
 * meaningful "registry exists and is empty". Malformed NODES are dropped row
 * by row rather than failing the batch, for the same reason
 * {@link parseEnvVarRow} drops them.
 */
export function parseTreeGet(stdout: string): TreeNodeRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const nodes = (parsed as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return null;
  const out: TreeNodeRecord[] = [];
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue;
    const doc = node as Record<string, unknown>;
    if (typeof doc['session'] !== 'string' || doc['session'].length === 0) continue;
    if (typeof doc['folder_path'] !== 'string' || doc['folder_path'].length === 0) continue;
    out.push({
      session: doc['session'],
      order: typeof doc['order'] === 'number' ? doc['order'] : 0,
      folderPath: doc['folder_path'],
      collapsed: doc['collapsed'] === true,
    });
  }
  return out;
}

/**
 * The `tree upsert` request body: `{"host": ..., "nodes": [...]}` on stdin.
 *
 * Upsert REPLACES the host's list (the helper's own help says "persist a
 * host's node list"), so callers must send the FULL merged list — the payload
 * builder is here, pure, because getting the wire shape wrong would silently
 * drop every session the phone recorded.
 */
export function treeUpsertPayload(host: string, nodes: readonly TreeNodeRecord[]): string {
  return JSON.stringify({
    host,
    nodes: nodes.map((n) => ({
      session: n.session,
      order: n.order,
      folder_path: n.folderPath,
      collapsed: n.collapsed,
    })),
  });
}

/**
 * Parse a `tree reconcile` response: `{"alive": [...], "gone": [...],
 * "added": [...]}` — session names in every list, never nodes. Null when the
 * answer is not a reconcile answer, matching {@link parseTreeGet}.
 */
export function parseTreeReconcile(stdout: string): {
  alive: string[];
  gone: string[];
  added: string[];
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = parsed as Record<string, unknown>;
  const names = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;
  const alive = names(doc['alive']);
  const gone = names(doc['gone']);
  const added = names(doc['added']);
  return alive && gone && added ? { alive, gone, added } : null;
}
