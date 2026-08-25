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

import type { SessionAgentKind, SessionSummary } from '../../shared/types.js';

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
 * session_path, session_attached, @ps_agent_kind`. Paths sit in the middle
 * rather than last (the phone parks `session_path` last for the same reason)
 * because a `::` inside a path would otherwise swallow the fields after it —
 * here the parser splits a FIXED count of fields, so only the two path
 * columns can be ambiguous and the scalar tail is always recoverable.
 *
 * That reasoning holds, but only if the parser actually splits from BOTH
 * ends, which it did not: it took the first seven fields left to right, so a
 * `::` in a path shifted `session_attached` and `@ps_agent_kind` one place
 * left and both were read out of a path fragment. {@link splitEnrichmentRow}
 * takes the three leading scalars and the two trailing ones by position from
 * their own end, which is what makes the tail genuinely recoverable.
 */
export const SESSION_ENRICHMENT_COMMAND =
  'tmux -u list-panes -a -F ' +
  `'#{session_name}${FIELD_SEP}#{window_active}${FIELD_SEP}#{pane_active}${FIELD_SEP}` +
  `#{pane_current_path}${FIELD_SEP}#{session_path}${FIELD_SEP}#{session_attached}` +
  `${FIELD_SEP}#{@ps_agent_kind}'`;

/** What the companion probe adds to a bare `sessions list` row. */
export interface SessionEnrichment {
  /** Active pane's cwd, falling back to `session_path`; null if neither. */
  path: string | null;
  attached: boolean;
  agentKind: SessionAgentKind | null;
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
    const { name, windowActive, paneActive, panePath, sessionPath, attached, kind } = row;

    const isActive = windowActive === '1' && paneActive === '1';
    if (activeSeen.has(name) && !isActive) continue;
    const path = (isActive ? panePath : '') || sessionPath || '';
    const attachedCount = Number.parseInt(attached, 10);
    out.set(name, {
      path: path ? path : null,
      attached: Number.isFinite(attachedCount) && attachedCount > 0,
      agentKind: agentKindFromTmuxOption(kind),
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
}

/**
 * Split one probe line into its seven fields, tolerating both of the shapes
 * the old fixed left-to-right split got wrong.
 *
 * ## Too many fields
 *
 * A `::` inside either path column produces MORE than seven parts. Reading
 * the first seven then shifted `session_attached` and `@ps_agent_kind` out of
 * a path fragment, which quietly reported the session as detached and
 * agent-less. Only the two path columns are ambiguous, so the three leading
 * scalars are taken from the front, the two trailing ones from the back, and
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

  // The tail is taken from the END so a `::` in a path cannot shift it. When
  // the row is short the tail fields simply are not there, and empty is the
  // right reading of both: no attach count means "not attached", no recorded
  // option means "we did not launch this".
  const hasKind = parts.length >= 7;
  const hasAttached = parts.length >= 6;
  const kind = hasKind ? (parts[parts.length - 1] ?? '') : '';
  const attached = hasAttached ? (parts[parts.length - (hasKind ? 2 : 1)] ?? '') : '';

  const middleEnd = parts.length - (hasKind ? 2 : hasAttached ? 1 : 0);
  const middle = parts.slice(3, middleEnd);
  const [panePath, sessionPath] = splitPathPair(middle);

  return { name, windowActive, paneActive, panePath, sessionPath, attached, kind };
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
export function mergeSessionEnrichment(
  sessions: SessionSummary[],
  enrichment: Map<string, SessionEnrichment>,
): SessionSummary[] {
  const lenient = lenientEnrichmentIndex(enrichment);
  return sessions.map((session) => {
    const extra = enrichment.get(session.name) ?? lenient.get(asciiSanitised(session.name));
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
function lenientEnrichmentIndex(
  enrichment: Map<string, SessionEnrichment>,
): Map<string, SessionEnrichment> {
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
  return index;
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
}

/** Parse `pocketshell usage --json` (one JSON object per line). */
export function parseUsageNdjson(stdout: string): UsageRow[] {
  const out: UsageRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as UsageRow);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// `pocketshell sessions resumable` — fixed-width table
// ---------------------------------------------------------------------------
//
// Real 0.4.44 output (`sessions resumable --all`), reproduced byte-for-byte:
//
//   IDX ENGINE    PROJECT             WHEN    LABEL
//   1   codex     dtc-website         just nowhttps://github.com/…
//   3   codex     git                 1m      I have this game idea…
//   5   claude    telegram-writing-assistant39m     articles/claw-drafts/…
//
// The helper renders it with `f"{idx:<4}{engine:<10}{project:<20}{when:<8}{label}"`
// (sessions.py:268-277), so the columns are IDX[0:4) ENGINE[4:14)
// PROJECT[14:34) WHEN[34:42) LABEL[42:end) — but `<` padding only pads, it
// never truncates, so BOTH of the two rows above break naive parsing:
//
//   * `just now` is exactly 8 chars and fills WHEN completely, leaving ZERO
//     whitespace before LABEL. The previous "split on the first 2+ space gap
//     after column 34" heuristic therefore swallowed the whole label into
//     WHEN and returned an empty label for every "just now" row.
//   * `telegram-writing-assistant` is 26 chars and overflows PROJECT, shifting
//     WHEN and LABEL right by 6. A hard slice at [14:34)/[34:42) then cut the
//     project mid-word and produced garbage for WHEN and LABEL.
//
// So we parse the fixed IDX/ENGINE prefix by column (both always fit) and then
// locate the WHEN/LABEL boundary by finding the WHEN token itself — the only
// field whose vocabulary is closed.

export interface ResumableSession {
  // See UsageRow.status: `string & {}` preserves narrowing on the known
  // engines while still round-tripping an unrecognised one.
  engine: 'claude' | 'codex' | 'opencode' | (string & {});
  project: string;
  /** Relative-time label as printed (e.g. "3h", "just now"). */
  when: string;
  label: string;
  running: boolean;
}

const RESUMABLE_HEADER_RE = /^\s*IDX\s+ENGINE\s+PROJECT\s+WHEN\s+LABEL/i;

/** Width of the PROJECT column, measured from the start of the tail. */
const RESUMABLE_PROJECT_WIDTH = 20;
/** Width of the WHEN column. */
const RESUMABLE_WHEN_WIDTH = 8;

/**
 * The complete vocabulary of the WHEN column, from the helper's
 * `format_relative` (resume.py:680-698): `just now`, then `<n>m`, `<n>h`,
 * `<n>d`, `<n>mo`, `<n>y`. `mo` is listed before the single-letter units so
 * the alternation cannot stop at the `m` of `11mo`.
 *
 * The "followed by whitespace" guard applies to the numeric forms ONLY, so a
 * digit run inside an overflowing project name is not mistaken for a WHEN.
 * `just now` needs no guard and must not have one: at exactly 8 chars it
 * fills the column with no trailing pad, so the label butts straight up
 * against it.
 */
const RESUMABLE_WHEN_RE = /^(just now|\d+(?:mo|[mhdy])(?=\s|$))/;

/** Parse `pocketshell sessions resumable` table. */
export function parseResumableTable(stdout: string): ResumableSession[] {
  const out: ResumableSession[] = [];
  let sawHeader = false;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, ''); // rstrip
    if (!line.trim()) continue;
    if (RESUMABLE_HEADER_RE.test(line)) {
      sawHeader = true;
      continue;
    }
    if (!sawHeader) continue;
    if (line.length <= 14) continue;
    // IDX[0:4) and ENGINE[4:14) always fit their columns — the index is at
    // most three digits for any realistic `-n`, and the widest engine
    // ("opencode", 8) still leaves two spaces.
    const engine = line.slice(4, 14).trim();
    if (!engine) continue;

    // PROJECT + WHEN + LABEL, with WHEN starting at max(20, project.length):
    // scan forward from the nominal column for the first WHEN token. Because
    // an overflowing project is a directory basename (no spaces), every byte
    // between the nominal start and the real one is non-space — so hitting
    // whitespace first means the row is not shaped as we expect and we fall
    // back to the nominal columns rather than dropping the row.
    const tail = line.slice(14);
    let whenStart = -1;
    let when = '';
    for (let i = RESUMABLE_PROJECT_WIDTH; i < tail.length; i++) {
      const match = RESUMABLE_WHEN_RE.exec(tail.slice(i));
      if (match) {
        whenStart = i;
        when = match[1]!;
        break;
      }
      if (/\s/.test(tail[i]!)) break; // ran out of padding without a WHEN
    }
    if (whenStart < 0) {
      whenStart = RESUMABLE_PROJECT_WIDTH;
      when = tail.slice(whenStart, whenStart + RESUMABLE_WHEN_WIDTH).trim();
    }
    const project = tail.slice(0, whenStart).trim();
    if (!project || !when) continue;
    // LABEL starts exactly one WHEN-column past the WHEN token; `just now`
    // fills that column with no separator at all, so trimming is not enough.
    let label = tail.slice(whenStart + Math.max(RESUMABLE_WHEN_WIDTH, when.length)).trim();

    let running = false;
    const runningTag = '(running)';
    if (label.endsWith(runningTag)) {
      running = true;
      label = label.slice(0, -runningTag.length).trim();
    }
    out.push({ engine, project, when, label, running });
  }
  return out;
}

// ---------------------------------------------------------------------------
// `pocketshell agent-log --json` — envelope
// ---------------------------------------------------------------------------

export interface AgentLogEnvelope {
  count: number;
  engine: string;
  /** Raw JSONL lines (each is one JSON object). */
  lines: string[];
  path: string;
  session: string;
}

/** Parse `pocketshell agent-log --json` envelope. Returns null if not JSON. */
export function parseAgentLogJson(stdout: string): AgentLogEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed) as Partial<AgentLogEnvelope>;
    if (!obj || typeof obj !== 'object') return null;
    return {
      count: obj.count ?? obj.lines?.length ?? 0,
      engine: obj.engine ?? '',
      lines: Array.isArray(obj.lines) ? obj.lines : [],
      path: obj.path ?? '',
      session: obj.session ?? '',
    };
  } catch {
    return null;
  }
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
