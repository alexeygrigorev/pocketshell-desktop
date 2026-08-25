import { describe, expect, it } from 'vitest';
import { windowCommandForInput, type WindowKeyInput } from '../../src/shared/windowKeys';

/**
 * Which keystrokes main is allowed to take from the terminal, now that the
 * default application menu is gone on Windows and Linux.
 *
 * The negative cases are the point of this file. `preventDefault()` on
 * `before-input-event` suppresses the PAGE's keydown as well as any
 * accelerator, so every chord this matcher claims is a chord the shell can
 * never see again — which is why the ones asserted as `null` below are
 * asserted at all. Each was measured against the real xterm this app ships,
 * with the bytes it produced written next to it, and each of them is a key
 * somebody works with every day:
 *
 *     Ctrl+W  -> "\x17"      readline delete-word (the reported bug)
 *     Ctrl+M  -> "\r"        readline accept-line
 *     Ctrl+R  -> "\x12"      readline reverse-i-search
 *     Ctrl+I  -> "\t"        completion
 *     F11     -> "\x1b[23~"  a function key TUIs bind
 *     Ctrl+Q / Ctrl+Z / Ctrl+X / Ctrl+A -> their own C0 bytes
 *
 * The two chords that ARE claimed were measured the same way and produce
 * NOTHING at the terminal: Ctrl+Shift+W and Ctrl+Shift+I both give xterm's
 * `onData` an empty list. That is the entire admission test for adding
 * anything here.
 */

/** A keydown, with everything not under test held at its resting value. */
function press(over: Partial<WindowKeyInput>): WindowKeyInput {
  return {
    type: 'keyDown',
    key: 'a',
    control: false,
    meta: false,
    alt: false,
    shift: false,
    ...over,
  };
}

describe('windowCommandForInput', () => {
  it('closes the window on Ctrl+Shift+W', () => {
    expect(windowCommandForInput(press({ key: 'W', control: true, shift: true }))).toBe('close');
  });

  it('accepts either case of the letter, because layouts disagree', () => {
    // Chromium reports the uppercase character for a shifted letter, but not
    // dependably across every layout and IME. The modifier test above has
    // already established this is a chord rather than typing, so accepting
    // both spellings costs nothing and closes a whole class of "works on my
    // keyboard".
    expect(windowCommandForInput(press({ key: 'w', control: true, shift: true }))).toBe('close');
  });

  it('closes on Cmd+Shift+W too, which is macOS getting a second spelling', () => {
    // darwin keeps its default menu, so Cmd+W still closes there; this is
    // additive rather than a replacement.
    expect(windowCommandForInput(press({ key: 'W', meta: true, shift: true }))).toBe('close');
  });

  it('toggles DevTools on Ctrl+Shift+I, the chord the default menu had', () => {
    expect(windowCommandForInput(press({ key: 'I', control: true, shift: true }))).toBe(
      'toggleDevTools',
    );
  });

  it('LEAVES Ctrl+W alone — that is the whole fix', () => {
    // Not "closes the window elsewhere and deletes a word in the terminal":
    // main cannot tell the two apart, so it claims neither. The terminal gets
    // \x17 because nothing intercepts it and no menu is holding the chord.
    expect(windowCommandForInput(press({ key: 'w', control: true }))).toBeNull();
  });

  it('leaves every other terminal chord alone', () => {
    for (const key of ['m', 'r', 'i', 'q', 'z', 'x', 'a', 'c', 'v', 'l', 's']) {
      expect(windowCommandForInput(press({ key, control: true }))).toBeNull();
    }
    expect(windowCommandForInput(press({ key: 'F11' }))).toBeNull();
    expect(windowCommandForInput(press({ key: 'F12' }))).toBeNull();
  });

  it('leaves the shifted chords the app has already claimed alone', () => {
    // Ctrl+Shift+V pastes into the shell and Ctrl+Shift+C copies from it; both
    // are handled in the renderer and must not be swallowed on the way there.
    expect(windowCommandForInput(press({ key: 'V', control: true, shift: true }))).toBeNull();
    expect(windowCommandForInput(press({ key: 'C', control: true, shift: true }))).toBeNull();
  });

  it('ignores a chord without Ctrl or Cmd', () => {
    expect(windowCommandForInput(press({ key: 'W', shift: true }))).toBeNull();
  });

  it('ignores Ctrl+Alt, which is AltGr on European layouts', () => {
    // Same rule as zoomKeys: AltGr+<something> is a printable character on
    // several layouts, and swallowing it would eat a letter.
    expect(
      windowCommandForInput(press({ key: 'W', control: true, alt: true, shift: true })),
    ).toBeNull();
  });

  it('only answers to keyDown', () => {
    expect(
      windowCommandForInput(press({ type: 'keyUp', key: 'W', control: true, shift: true })),
    ).toBeNull();
  });
});
