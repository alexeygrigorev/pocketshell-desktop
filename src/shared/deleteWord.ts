/**
 * Readline's delete-word-backward (`unix-word-rubout`, `\x17`) for the app's
 * own text fields.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `Ctrl+W` used to be Electron's default-menu Close role, so a keystroke
 * pressed from muscle memory next to ANY text field threw away the whole app
 * — every attached session with it. Removing the menu gave the TERMINAL its
 * `\x17` back (xterm was already encoding it; see src/shared/windowKeys.ts)
 * and left every other surface holding a dead key. Chromium binds nothing to
 * Ctrl+W natively, so this module is what makes the dead key mean again what
 * readline trained into people's hands: kill back to the previous whitespace,
 * exactly like bash.
 *
 * Deliberately WHITESPACE-delimited, not letter/punctuation-delimited. This
 * is `unix-word-rubout`, not `backward-kill-word` (which would stop at a `.`
 * or `/`): the habit the chord comes from is "wipe the argument I just typed",
 * and half-killing `~/git/pocke|` would be a different, cleverer behaviour
 * nobody asked for.
 *
 * Pure by construction: value in, {value, caret} out. The DOM glue that calls
 * it lives in `App.vue` and does nothing this file could get wrong.
 */

/** One field edit: the new value and where the caret ends up. */
export interface DeleteWordResult {
  value: string;
  caret: number;
}

/**
 * Kill backwards from [selectionStart, selectionEnd).
 *
 * With a SELECTION, the selection is what dies — same as Backspace does — and
 * the caret lands at its start. Collapsed: everything from the caret back to
 * (but not through) the nearest whitespace is removed, TRAILING WHITESPACE
 * INCLUDED, which is bash's behaviour: on `foo bar   |` one press produces
 * `foo `, not `foo bar  `. The gap belongs to the word being killed, and
 * what survives is still separated from what came before by exactly the
 * whitespace that was there originally.
 */
export function deleteWordBackward(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): DeleteWordResult {
  // Clamp against hostile arguments rather than trusting the caller: a stale
  // snapshot can disagree with the current value, and String.slice tolerates
  // out-of-range indices silently producing nonsense deletions.
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));

  let from = start;
  if (from === end) {
    const isSpace = (i: number): boolean => /\s/.test(value[i] ?? '');
    while (from > 0 && isSpace(from - 1)) from -= 1;
    while (from > 0 && !isSpace(from - 1)) from -= 1;
  }

  return {
    value: value.slice(0, from) + value.slice(end),
    caret: from,
  };
}
