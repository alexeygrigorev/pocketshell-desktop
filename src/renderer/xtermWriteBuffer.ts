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

interface CoreBufferInternals {
  lines: {
    length: number;
    push: (line: unknown) => void;
  };
  ybase: number;
  getBlankLine: (attr: unknown) => unknown;
  getNullCell: () => unknown;
}

interface CoreBufferState {
  buffer: CoreBufferInternals;
  rows: number;
}

/** Read the private core buffer facts needed to validate xterm's invariant. */
function coreBufferState(term: TermLike): CoreBufferState | null {
  const core = (term as { _core?: unknown } | null | undefined)?.['_core'];
  if (typeof core !== 'object' || core === null) return null;

  const value = core as {
    rows?: unknown;
    buffers?: { active?: unknown };
  };
  const active = value.buffers?.active;
  if (typeof active !== 'object' || active === null) return null;

  const rawBuffer = active as Record<string, unknown>;
  const lines = rawBuffer['lines'];
  const getBlankLine = rawBuffer['getBlankLine'];
  const getNullCell = rawBuffer['getNullCell'];
  const length = (lines as { length?: unknown } | null)?.length;
  const ybase = rawBuffer['ybase'];
  if (
    typeof value.rows !== 'number' || !Number.isInteger(value.rows) || value.rows < 1 ||
    typeof ybase !== 'number' || !Number.isInteger(ybase) || ybase < 0 ||
    typeof length !== 'number' || !Number.isInteger(length) || length < 0 ||
    typeof lines !== 'object' || lines === null ||
      typeof (lines as { push?: unknown }).push !== 'function' ||
    typeof getBlankLine !== 'function' || typeof getNullCell !== 'function'
  ) {
    return null;
  }

  return {
    rows: value.rows,
    // Keep the real Buffer as the receiver for getNullCell/getBlankLine;
    // those methods use other private fields on `this` when constructing a
    // line. The cast is safe only after the shape checks above.
    buffer: rawBuffer as unknown as CoreBufferInternals,
  };
}

/**
 * Whether xterm has a live line backing every row of the active viewport.
 *
 * This reads `_core.buffers.active` instead of `term.buffer.active`: xterm
 * 6.0.0 gates the latter behind `allowProposedApi`, which the renderer does not
 * enable. The logical length matters here rather than `lines.get()`:
 * CircularList can expose stale backing-array entries beyond that logical
 * length, which is how xterm 6.0.0 hides the broken state until a later scroll
 * operation.
 */
export function hasCompleteViewport(term: TermLike): boolean {
  const state = coreBufferState(term);
  return state !== null && state.buffer.lines.length >= state.buffer.ybase + state.rows;
}

/**
 * Backfill a terminal whose active buffer invariant is already broken.
 *
 * xterm 6.0.0's row-growing resize can consume scrollback by decrementing
 * `ybase` without pushing replacement lines. Recreate the same blank-line
 * construction used by xterm's own resize path until every viewport row has a
 * logical line. This preserves parser state and existing screen contents; no
 * terminal reset or remote repaint is needed.
 */
export function repairIncompleteViewport(term: TermLike): boolean {
  const state = coreBufferState(term);
  if (!state || state.buffer.lines.length >= state.buffer.ybase + state.rows) return false;

  try {
    const nullCell = state.buffer.getNullCell.call(state.buffer);
    const targetLength = state.buffer.ybase + state.rows;
    while (state.buffer.lines.length < targetLength) {
      const oldLength = state.buffer.lines.length;
      const blankLine = state.buffer.getBlankLine.call(state.buffer, nullCell);
      if (blankLine === null || blankLine === undefined) return false;
      state.buffer.lines.push(blankLine);
      if (state.buffer.lines.length <= oldLength) return false;
    }
  } catch {
    return false;
  }

  return hasCompleteViewport(term);
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
