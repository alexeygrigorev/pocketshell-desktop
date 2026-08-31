/**
 * Resumes xterm's write loop after a parser throw has killed it.
 *
 * ## The death it undoes
 *
 * xterm parses `write()` chunks in `WriteBuffer._innerWrite`, driven by a
 * `setTimeout` it reschedules only when the pass completes normally. A
 * handler that throws — real case, this repo: `CircularList.shiftElements`
 * throwing `start argument out of range` out of `reverseIndex` for a tmux
 * pane streaming agent-TUI output — escapes the pass, the reschedule never
 * runs, and the loop is dead: the chunk it died on sits at `_bufferOffset`
 * forever, every later `write()` piles up behind it, and the pane freezes.
 * Nothing public can restart the loop.
 *
 * ## What this does
 *
 * Retires the chunk the loop died on (fire its completion callback, account
 * its bytes, advance the offset) and calls `_innerWrite()` again, which
 * parses the surviving backlog and takes over the rescheduling from there.
 * Two losses survive the resume, and they shape the contract: the dead
 * chunk's un-parsed tail is gone (the same trade xterm itself makes for
 * async-handler errors), and the parser is still mid-escape-sequence — the
 * first bytes of the next chunk get consumed as that sequence's continuation
 * (a test run measured ` p` of a following ` probe` eaten by a half-entered
 * CSI). So a resume alone does not make the pane whole; the caller follows it
 * with the heavier repair (a fresh join, whose `reset()` re-initialises the
 * parser from a known state), because a parser that threw mid-chunk leaves
 * the emulator's state suspect no matter what the loop does next.
 *
 * ## Why the shape checks
 *
 * `_core._writeBuffer` is xterm private API. The names survive the minifier
 * (they are property names; the production stack trace in the desktop log
 * shows `gn._innerWrite` verbatim), but an xterm upgrade could restructure
 * them. Every access is checked first, and anything unexpected returns
 * `false` — a plain no-op — rather than a recovery that half-applies. The
 * regression test runs against the real `@xterm/headless` internals for
 * exactly this reason.
 */

/** Anything at all — the shape checks below are the whole contract. */
type TermLike = unknown;

/** The slice of WriteBuffer's shape this function needs, all verified before use. */
interface WriteBufferInternals {
  _writeBuffer: { length: number }[];
  _callbacks: (undefined | (() => void))[];
  _pendingData: number;
  _bufferOffset: number;
  _innerWrite: () => void;
}

function internals(term: TermLike): WriteBufferInternals | null {
  const wb = (term as { _core?: { _writeBuffer?: unknown } } | null | undefined | void)?.['_core']?.['_writeBuffer'];
  if (typeof wb !== 'object' || wb === null) return null;
  const w = wb as Record<string, unknown>;
  if (!Array.isArray(w['_writeBuffer']) || !Array.isArray(w['_callbacks'])) return null;
  if (typeof w['_pendingData'] !== 'number' || typeof w['_bufferOffset'] !== 'number') return null;
  if (typeof w['_innerWrite'] !== 'function') return null;
  return w as unknown as WriteBufferInternals;
}

/**
 * Try to restart a wedged write loop.
 *
 * Returns `true` if the loop was wedged and has been resumed, `false` when
 * there was nothing to do (the loop is healthy) or the internals did not
 * match the expected shape (an upgraded xterm — the stall report will say
 * the recovery did not run).
 */
export function resumeWriteBufferAfterError(term: TermLike): boolean {
  const wb = internals(term);
  if (!wb) return false;
  const offset = wb._bufferOffset;
  // A live loop sits at or past its end between passes; only a wedged one
  // points at a chunk that will never complete.
  if (offset >= wb._writeBuffer.length) return false;

  // Retire the dead chunk the way the loop would have: callback first, then
  // the byte accounting, then the offset. (`_writeBuffer[offset]` is in
  // range by the offset check above; the index types just can't see it.)
  wb._callbacks[offset]?.();
  const dead = wb._writeBuffer[offset]!;
  wb._pendingData = Math.max(0, wb._pendingData - dead.length);
  wb._bufferOffset = offset + 1;

  if (wb._bufferOffset >= wb._writeBuffer.length) {
    // Nothing survived behind the dead chunk — close the queue out exactly
    // like a normal final pass would, and skip the restart call.
    wb._writeBuffer.length = 0;
    wb._callbacks.length = 0;
    wb._pendingData = 0;
    wb._bufferOffset = 0;
    return true;
  }
  // Restart the loop on the surviving backlog; it reschedules itself from here.
  // Property access + call keeps `this` on the WriteBuffer, as the method expects.
  wb._innerWrite();
  return true;
}
