/**
 * Pure functions for parsing and filtering PocketShell log output.
 *
 * The remote `pocketshell logs` command emits NDJSON (one JSON object per
 * line). Each line may contain arbitrary keys; we normalise them into
 * {@link LogEntry} objects.
 */

import type { LogEntry, LogFilter, LogLevel } from './types';

// ---------------------------------------------------------------------------
// NDJSON parser
// ---------------------------------------------------------------------------

/**
 * Parse raw NDJSON output from `pocketshell logs` into an array of
 * {@link LogEntry} objects.
 *
 * Malformed or blank lines are silently skipped so that a single bad line
 * does not blow up the whole batch.
 */
export function parseLogs(output: string): LogEntry[] {
  const entries: LogEntry[] = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw: Record<string, any>;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      // Skip malformed lines
      continue;
    }

    const entry = normaliseEntry(raw);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Apply a {@link LogFilter} to a list of log entries.
 *
 * All specified filter criteria must match (AND semantics).
 * The `search` field performs a case-insensitive substring match on
 * `message`.
 */
export function filterLogs(entries: LogEntry[], filter: LogFilter): LogEntry[] {
  return entries.filter((entry) => {
    if (filter.level !== undefined && entry.level !== filter.level) {
      return false;
    }

    if (filter.source !== undefined && entry.source !== filter.source) {
      return false;
    }

    if (filter.since !== undefined && entry.timestamp < filter.since) {
      return false;
    }

    if (filter.until !== undefined && entry.timestamp >= filter.until) {
      return false;
    }

    if (
      filter.search !== undefined &&
      !entry.message.toLowerCase().includes(filter.search.toLowerCase())
    ) {
      return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a raw JSON object from `pocketshell logs` into a LogEntry.
 *
 * Known key mappings from the fixture format:
 *   ts      -> timestamp   (ISO-8601 string or numeric)
 *   kind    -> source
 *   msg     -> message
 *   level   -> level       (defaults to 'info')
 *
 * Any extra keys are collected into `metadata`.
 */
function normaliseEntry(raw: Record<string, any>): LogEntry | null {
  // timestamp
  let timestamp: number;
  const ts = raw.ts ?? raw.timestamp;
  if (ts === undefined) return null;

  if (typeof ts === 'number') {
    timestamp = ts;
  } else if (typeof ts === 'string') {
    timestamp = Date.parse(ts);
    if (Number.isNaN(timestamp)) return null;
  } else {
    return null;
  }

  // message
  const message = String(raw.msg ?? raw.message ?? '');

  // level
  const rawLevel = raw.level;
  const level = isValidLevel(rawLevel) ? rawLevel : 'info';

  // source
  const source = raw.kind ?? raw.source ?? raw.component ?? undefined;
  const sourceStr = source !== undefined ? String(source) : undefined;

  // metadata — collect any keys we haven't already consumed
  const knownKeys = new Set(['ts', 'timestamp', 'msg', 'message', 'level', 'kind', 'source', 'component']);
  const metadataKeys = Object.keys(raw).filter((k) => !knownKeys.has(k));
  const metadata: Record<string, any> | undefined =
    metadataKeys.length > 0
      ? Object.fromEntries(metadataKeys.map((k) => [k, raw[k]]))
      : undefined;

  return {
    timestamp,
    level,
    message,
    ...(sourceStr !== undefined && { source: sourceStr }),
    ...(metadata !== undefined && { metadata }),
  };
}

function isValidLevel(value: any): value is LogLevel {
  return typeof value === 'string' && value in LEVEL_ORDER;
}
