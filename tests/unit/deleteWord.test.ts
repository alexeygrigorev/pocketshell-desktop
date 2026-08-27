import { describe, expect, it } from 'vitest';
import { deleteWordBackward } from '../../src/shared/deleteWord';

/**
 * Readline's unix-word-rubout for the app's text fields.
 *
 * The semantics this pins are bash's, not a spell-checker's: whitespace is
 * the ONLY word separator, and the trailing gap belongs to the word killed
 * (`foo bar   |` -> `foo ` in ONE press). Everything else about the feature —
 * the DOM glue, the `.xterm` stand-down, the macOS skip — is in App.vue on
 * purpose; this module is the part that could get boundary cases wrong, so
 * the boundary cases are what these tests drive.
 */
describe('deleteWordBackward', () => {
  const cut = (value: string, start: number, end = start) =>
    deleteWordBackward(value, start, end);

  it('kills back through the previous whitespace', () => {
    expect(cut('rm -rf /tmp/build', 17)).toEqual({ value: 'rm -rf ', caret: 7 });
    // ...and the separator BEFORE the killed word is not eaten — only the gap
    // between caret and word belongs to the kill.
    expect(cut('echo hi', 7)).toEqual({ value: 'echo ', caret: 5 });
  });

  it('takes the trailing gap WITH the word, as bash does', () => {
    expect(cut('foo bar   ', 10)).toEqual({ value: 'foo ', caret: 4 });
    expect(cut('go   ', 5)).toEqual({ value: '', caret: 0 });
    // The gap before a caret in mid-prose goes with the kill too.
    expect(cut('a b   c', 6)).toEqual({ value: 'a c', caret: 2 });
  });

  it('takes punctuation as part of the word (unix-word-rubout, not backward-kill-word)', () => {
    // Half-killing "~/git/pocke|" would be CLEVERER than the shell; the chord
    // exists because people want the argument GONE.
    expect(cut('~/git/pocke', 11)).toEqual({ value: '', caret: 0 });
  });

  it('kills the selection whole, caret landing at its start', () => {
    expect(cut('one two three', 4, 7)).toEqual({ value: 'one  three', caret: 4 });
  });

  it('leaves an empty field alone', () => {
    expect(cut('', 0)).toEqual({ value: '', caret: 0 });
  });

  it('clamps a caret past the end instead of slicing into nonsense', () => {
    // A stale snapshot of value/selection can disagree with each other; the
    // pure result must still be coherent for whatever glue applies it.
    expect(cut('word', 99)).toEqual({ value: '', caret: 0 });
    expect(cut('word', 2, 99)).toEqual({ value: 'wo', caret: 2 });
    // Clamped to the start of the value, there is nothing before the caret to
    // kill: a coherent no-op, not an off-by-one deletion.
    expect(cut('word', -1)).toEqual({ value: 'word', caret: 0 });
  });

  it('treats every kind of whitespace as a boundary, including newlines', () => {
    const value = 'first\nsecond ';
    expect(cut(value, value.length)).toEqual({ value: 'first\n', caret: 6 });
  });
});
