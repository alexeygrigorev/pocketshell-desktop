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

import type { SessionSummary } from '../../shared/types.js';

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
// Footer/hint lines and a blank separator are skipped.

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
      attached: false,
      path: null,
    });
  }
  return out;
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
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// `pocketshell usage --json` — NDJSON rows
// ---------------------------------------------------------------------------

export interface UsageRow {
  provider: string;
  status: 'ok' | 'limited' | 'blocked' | 'error' | string;
  short_term: { percent_remaining: number; reset_at: string | null };
  long_term: { percent_remaining: number; reset_at: string | null };
  block_reason: string | null;
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
//   IDX ENGINE    PROJECT              WHEN     LABEL
//   1   claude    pocketshell          3h       fix the parser
//   2   codex     pocketshell          1d       (running)

export interface ResumableSession {
  engine: 'claude' | 'codex' | 'opencode' | string;
  project: string;
  /** Relative-time label as printed (e.g. "3h", "just now"). */
  when: string;
  label: string;
  running: boolean;
}

const RESUMABLE_HEADER_RE = /^\s*IDX\s+ENGINE\s+PROJECT\s+WHEN\s+LABEL/i;

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
    // Fixed-width columns (from _format_resumable_table):
    //   IDX[0:4) ENGINE[4:14) PROJECT[14:34) WHEN[34:42) LABEL[42:end)
    // The first three are fixed. WHEN can overflow its 8-wide column
    // ("just now" is 9 chars), so we locate the WHEN->LABEL boundary by the
    // run of 2+ spaces after column 34 rather than a hard slice at 42.
    if (line.length < 34) continue;
    const engine = line.slice(4, 14).trim();
    const project = line.slice(14, 34).trim();
    if (!engine || !project) continue;

    // From column 34 onward, find the first 2+ space gap: that separates
    // WHEN from LABEL. If there is no gap, the whole tail is WHEN (no label).
    const tail = line.slice(34);
    const gap = /\s{2,}/.exec(tail);
    let when: string;
    let label: string;
    if (gap) {
      when = tail.slice(0, gap.index).trim();
      label = tail.slice(gap.index + gap[0].length).trim();
    } else {
      when = tail.trim();
      label = '';
    }
    if (!when) continue;

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
