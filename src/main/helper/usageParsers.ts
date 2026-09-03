/**
 * Pure parsers for `pocketshell usage --json` — NDJSON rows.
 *
 * Each parser turns raw stdout into typed rows, pinned to fixture strings so
 * the output contract stays byte-identical to what the real helper emits.
 */

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
