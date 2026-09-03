/**
 * Detects a wedged xterm write loop, and says WHICH chunk it died on.
 *
 * ## The failure this exists for
 *
 * `term.write(data)` does not parse `data` synchronously. xterm queues the
 * chunk and drains the queue in a `setTimeout` loop
 * (`WriteBuffer._innerWrite`); the completion callback passed to `write()`
 * fires when the chunk has been parsed. When a byte sequence makes xterm's
 * parser throw — measured live in this repo: `CircularList.shiftElements`
 * throwing `start argument out of range` from a `reverseIndex` handler while a
 * tmux pane fed it agent-TUI output — the exception escapes that loop, the
 * loop never reschedules, and every later `write()` silently piles onto a
 * queue nobody will ever drain again. The pane freezes mid-stream: no error
 * on screen, no spinner, bytes in, nothing rendered. The thrown error DOES
 * reach the window `error` handler (diag.ts), but nothing tied it to a pane,
 * and nothing noticed that the pane had stopped parsing.
 *
 * So every write into a pane goes through here with a completion callback,
 * and the HEAD of the queue sits under a timer. A healthy parse of one chunk
 * is sub-millisecond; if the head's callback has not run within
 * {@link PARSE_STALL_TIMEOUT_MS} the loop is dead, and the report carries what
 * a root cause needs: the exact bytes that killed the parse (printable and
 * hex, capped), how much was queued behind them, and the terminal's buffer
 * state read live at stall time via {@link ParseStallMonitorOptions.describe}.
 *
 * The timer is armed on the head only, and re-armed as the queue drains — an
 * entry's wait starts when it is its TURN, not when it was queued, so a deep
 * backlog under heavy output cannot trip it. The timer runs on the same
 * thread as the parser, so a busy renderer delays both equally and cannot
 * produce a false stall either.
 */

/** How long a chunk may sit at the head un-parsed before the loop is called wedged. */
export const PARSE_STALL_TIMEOUT_MS = 2_000;

/** Cap for the byte previews in a report — enough to see the sequence, not the scrollback. */
const PREVIEW_BYTES = 256;

/** Minimal surface of xterm's Terminal this module needs. */
export interface WritableTerminal {
  write(data: string | Uint8Array, callback?: () => void): void;
}

/** What a stall report says. `details` is whatever {@link describe} read live. */
export interface ParseStallReport {
  /** Printable preview of the chunk that never finished parsing. */
  chunk: string;
  /** Hex preview of the same bytes, for control characters the printable form hides. */
  chunkHex: string;
  /** Full length of the stalled chunk in characters. */
  chunkLength: number;
  /** How many chunks were queued behind the stalled head when it was detected. */
  pendingBehind: number;
  /** How long the head had sat un-parsed. */
  ageMs: number;
  details: Record<string, unknown>;
}

export interface ParseStallMonitorOptions {
  /** Live pane facts for the report — session, geometry, buffer state. */
  describe?: () => Record<string, unknown>;
  /** Called once per detected stall. */
  onStall: (report: ParseStallReport) => void;
}

interface QueueEntry {
  data: string | Uint8Array;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class ParseStallMonitor {
  private queue: QueueEntry[] = [];
  /** True while the head is a chunk already reported as stalled — report each wedge once. */
  private reportedHead: QueueEntry | null = null;

  constructor(private options: ParseStallMonitorOptions) {}

  /**
   * Write `data` into `term` under observation. Completion callbacks are
   * FIFO, like xterm's own queue, so the head entry is the chunk being
   * parsed right now.
   */
  write(term: WritableTerminal, data: string | Uint8Array): void {
    const entry: QueueEntry = { data, enqueuedAt: Date.now(), timer: null };
    this.queue.push(entry);
    if (this.queue.length === 1 && !this.reportedHead) this.arm(entry);
    term.write(data, () => this.complete(entry));
  }

  /** Clear pending timers; the terminal is going away. */
  dispose(): void {
    for (const entry of this.queue) this.disarm(entry);
    this.queue = [];
    this.reportedHead = null;
  }

  private arm(entry: QueueEntry): void {
    this.disarm(entry);
    entry.timer = setTimeout(() => this.onTimeout(entry), PARSE_STALL_TIMEOUT_MS);
  }

  private disarm(entry: QueueEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  private complete(entry: QueueEntry): void {
    this.disarm(entry);
    const wasHead = this.queue[0] === entry;
    this.queue = this.queue.filter((e) => e !== entry);
    if (this.reportedHead === entry) this.reportedHead = null;
    const nextHead = this.queue[0];
    if (wasHead && nextHead && !this.reportedHead) {
      this.arm(nextHead);
    }
  }

  private onTimeout(head: QueueEntry): void {
    head.timer = null;
    if (this.queue[0] !== head || this.reportedHead === head) return;
    this.reportedHead = head;
    this.options.onStall({
      chunk: printablePreview(head.data, PREVIEW_BYTES),
      chunkHex: hexPreview(head.data, PREVIEW_BYTES),
      chunkLength: byteLength(head.data),
      pendingBehind: this.queue.length - 1,
      ageMs: Date.now() - head.enqueuedAt,
      details: this.options.describe?.() ?? {},
    });
  }
}

function byteLength(data: string | Uint8Array): number {
  return data.length;
}

/** Printable preview; control bytes become codes so the preview stays one line. */
function printablePreview(data: string | Uint8Array, maxBytes: number): string {
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
  let out = '';
  for (let i = 0; i < text.length && i < maxBytes; i++) {
    const code = text.charCodeAt(i);
    out += code >= 0x20 && code !== 0x7f ? text[i] : `\\x${code.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/** `abc` -> `61 62 63`; control bytes stay legible, which is the point. */
function hexPreview(data: string | Uint8Array, maxBytes: number): string {
  const bytes = typeof data === 'string' ? Array.from(data, (c) => c.charCodeAt(0)) : Array.from(data);
  return bytes
    .slice(0, maxBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}
