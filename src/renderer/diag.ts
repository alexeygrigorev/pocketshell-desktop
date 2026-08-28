/**
 * Unhandled renderer errors, recorded once and shown once.
 *
 * The gap this fills is the usage panel's old failure mode: a component that
 * threw during render left Vue's patch aborted, and the user saw a blank panel
 * — no message, no log line, nothing to paste. A packaged app has no console,
 * so "check devtools" is not an answer either.
 *
 * Two sinks, both best-effort:
 *   - `api.diag.log` forwards to the main process, which writes the same
 *     desktop log every exec lands in — the artifact a user is asked to paste;
 *   - `diagErrors` drives the app-wide strip (DiagBanner in App.vue), so the
 *     failure is visible at the moment it happens.
 *
 * Reporting is deliberately swallow-everything: code that runs because
 * something else already failed must not be able to make things worse.
 */
import { ref } from 'vue';
import { api } from './ipc';

/** Where an unhandled error was caught. Drives the desktop-log line only. */
export type DiagKind = 'render' | 'unhandledrejection' | 'error';

export interface DiagEntry {
  kind: DiagKind;
  message: string;
  /** `Error.stack` when there was one; the banner's `title`, the log's detail. */
  stack: string | null;
  /**
   * Identity, not a timestamp: two errors can land in the same millisecond,
   * and the strip dismisses per row — a wall-clock stamp would dismiss both.
   */
  id: number;
}

/**
 * Bounded: an error thrown from a hot path (a poll, a repeated render) would
 * otherwise crowd the strip with copies of itself. Older entries fall off.
 */
const MAX_ENTRIES = 4;

export const diagErrors = ref<DiagEntry[]>([]);

let nextId = 1;

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'unknown error';
  const text = String(error);
  return text || 'unknown error';
}

/**
 * Record one unhandled error. Consecutive duplicates collapse into the newest
 * occurrence — same message AND kind counts as the same incident repeating,
 * not a new one worth a second row.
 */
export function recordDiagError(kind: DiagKind, error: unknown): void {
  const message = toMessage(error);
  const stack = error instanceof Error && error.stack ? error.stack : null;
  try {
    api.diag.log({ kind, message, stack: stack ?? undefined });
  } catch {
    // The log channel is the last resort; if it is dead there is nothing
    // left to fall back to, and throwing here would mask the real error.
  }
  const current = diagErrors.value;
  const newest = current[current.length - 1];
  // Same error repeating: leave the row alone — it is the same incident.
  if (newest && newest.kind === kind && newest.message === message) return;
  const entry: DiagEntry = { kind, message, stack, id: nextId++ };
  const next = [...current, entry];
  diagErrors.value = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
}

/** Dismiss one strip row (by its id) — the user read it or moved on. */
export function dismissDiagError(id: number): void {
  diagErrors.value = diagErrors.value.filter((e) => e.id !== id);
}
