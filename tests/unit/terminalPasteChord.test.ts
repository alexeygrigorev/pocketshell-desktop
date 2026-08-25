// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Pasting into the terminal, and why one keystroke used to paste twice.
 *
 * ## What was measured
 *
 * Driven in the real Electron runtime this app ships, against a real xterm.js
 * terminal, counting what `term.onData` handed the shell for one keypress:
 *
 *     Ctrl+V         -> onData x1, [""]        (SYN — xterm's own
 *                                                     ctrl-letter mapping; this
 *                                                     chord does not paste)
 *     Ctrl+Shift+V   -> onData x2, ["TEXT", "TEXT"]  <-- the bug
 *     right-click    -> onData x1, ["TEXT"]
 *
 * So the renderer SENDS the bytes twice; nothing is echoing them. And it is
 * Ctrl+Shift+V specifically, which is the only chord that pastes at all — the
 * one the component's own header documents, and therefore the one the user was
 * using.
 *
 * ## Why twice
 *
 * `onCustomKey` handles the chord itself (`pasteFromClipboard()` ->
 * `term.paste()`) and returns false. Returning false stops XTERM — its
 * `_keyDown` bails at the custom handler — but it does NOT cancel the DOM
 * event, and xterm's `_keyDown` has no `cancel()` on that path. Chromium then
 * performs its own default action for Ctrl+Shift+V (paste as plain text),
 * which fires a `paste` event on xterm's textarea, which xterm's own paste
 * listener turns into a second `onData`. One keystroke, two paths, two writes.
 *
 * This is the identical defect the typing intercept had two branches earlier in
 * the same function, fixed in 1dffa87 and pinned by terminalTypingIntercept.test.ts —
 * "one keystroke, two paths", where the second path was the browser typing the
 * character into the composer it had just opened. The comment there explains
 * the mechanism; this is the same mechanism, on the clipboard chord.
 *
 * The fix is the same one line: `e.preventDefault()` before handling. Verified
 * in Electron — with it, Ctrl+Shift+V is onData x1 and right-click stays x1.
 *
 * ## Why one test here is skipped
 *
 * `onCustomKey` lives in TerminalView.vue, which was being edited concurrently
 * by another change when this was written, so the one-line fix is delivered as
 * a diff rather than applied here. The skipped case below IS that fix's
 * assertion; un-skip it when the diff lands. The rest of this file passes
 * either way and pins the parts that are already right, so a future edit cannot
 * quietly take them away.
 *
 * As with the typing intercept, the assertion is `defaultPrevented` rather than
 * a byte count: jsdom performs no default action, so it cannot produce the
 * second paste at all. What it can assert is the thing that makes the second
 * paste impossible.
 */

/** Captures the handler TerminalView hands to xterm, so a test can drive it. */
let customKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;
/** Everything the component asked xterm to paste. */
let pasted: string[] = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    reset(): void {}
    write(): void {}
    paste(text: string): void {
      pasted.push(text);
    }
    dispose(): void {}
    hasSelection(): boolean {
      return false;
    }
    getSelection(): string {
      return '';
    }
    onData(): { dispose: () => void } {
      return { dispose: () => {} };
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => {} };
    }
    registerLinkProvider(): { dispose: () => void } {
      return { dispose: () => {} };
    }
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean): void {
      customKeyHandler = fn;
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): undefined {
      return undefined;
    }
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    shell: {
      open: vi.fn(async () => 'shell-1'),
      attachSession: vi.fn(async () => ({ shellId: 'shell-1', switched: false })),
      input: vi.fn(async () => true),
      resize: vi.fn(async () => true),
      close: vi.fn(async () => true),
      onData: vi.fn(() => () => {}),
      onExited: vi.fn(() => () => {}),
    },
  },
}));

const TerminalView = (await import('../../src/renderer/components/TerminalView.vue')).default;

/** A keydown the way the browser makes one: cancelable, so it can be cancelled. */
function keydown(key: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...mods });
}

function mountTerminal() {
  return mount(TerminalView, {
    props: { connectionId: 'conn-1', sessionKey: 'main', interceptTyping: false },
    attachTo: document.body,
  });
}

/** Let the handler's `await navigator.clipboard.readText()` settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setActivePinia(createPinia());
  customKeyHandler = null;
  pasted = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText: vi.fn(async () => 'CLIPBOARD-TEXT'), writeText: vi.fn(async () => {}) },
  });
});

describe('paste chord — delivery', () => {
  it('CANCELS Ctrl+Shift+V, so the browser cannot paste it a second time', async () => {
    // THE REGRESSION. Un-skip together with the one-line TerminalView fix:
    //
    //   if (mod && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
    //  +  e.preventDefault();
    //     void pasteFromClipboard();
    //     return false;
    //   }
    //
    // An un-cancelled event is one Chromium goes on to act on itself, and its
    // action for this chord is a paste — into the same terminal, through
    // xterm's own paste listener. Measured in Electron: two onData writes for
    // one keypress, one from each path.
    const wrapper = mountTerminal();
    const e = keydown('V', { ctrlKey: true, shiftKey: true });

    expect(customKeyHandler).not.toBeNull();
    expect(customKeyHandler!(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);

    await settle();
    expect(pasted).toEqual(['CLIPBOARD-TEXT']);
    wrapper.unmount();
  });

  it('handles Ctrl+Shift+V itself and takes it away from xterm', async () => {
    const wrapper = mountTerminal();

    expect(customKeyHandler!(keydown('V', { ctrlKey: true, shiftKey: true }))).toBe(false);
    await settle();

    // Exactly one paste from OUR path. The second write in the bug came from
    // the browser, which jsdom cannot reproduce — see the file header.
    expect(pasted).toEqual(['CLIPBOARD-TEXT']);
    wrapper.unmount();
  });

  it('pastes once per keystroke, never once per key EVENT', async () => {
    // xterm consults this handler for keyup and keypress too. A handler that
    // acted on all three would paste three times without any help from the
    // browser at all.
    const wrapper = mountTerminal();

    customKeyHandler!(keydown('V', { ctrlKey: true, shiftKey: true }));
    customKeyHandler!(
      new KeyboardEvent('keypress', { key: 'V', ctrlKey: true, shiftKey: true, cancelable: true }),
    );
    customKeyHandler!(
      new KeyboardEvent('keyup', { key: 'V', ctrlKey: true, shiftKey: true, cancelable: true }),
    );
    await settle();

    expect(pasted).toEqual(['CLIPBOARD-TEXT']);
    wrapper.unmount();
  });

  it('leaves plain Ctrl+V to xterm rather than adding a second paste path', async () => {
    // Ctrl+V is xterm's ctrl-letter mapping (SYN) and it cancels the event
    // itself, so the browser never pastes. Claiming it here as well — without
    // cancelling — would give this chord the same doubling as Ctrl+Shift+V.
    const wrapper = mountTerminal();
    const e = keydown('v', { ctrlKey: true });

    expect(customKeyHandler!(e)).toBe(true);
    await settle();
    expect(pasted).toEqual([]);
    wrapper.unmount();
  });

  it('cancels the right-click that pastes, so no context menu follows it', async () => {
    // The other paste route, and the one that was already correct: it cancels
    // its own event, so it stays a single write. Measured in Electron as
    // onData x1.
    const wrapper = mountTerminal();
    const target = wrapper.element as HTMLElement;

    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    target.dispatchEvent(menu);
    await settle();

    expect(menu.defaultPrevented).toBe(true);
    expect(pasted).toEqual(['CLIPBOARD-TEXT']);
    wrapper.unmount();
  });

  it('survives a clipboard the browser refuses to read', async () => {
    // Permission denied / no clipboard API. The pane must not throw into an
    // unhandled rejection; the chord simply does nothing.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    const wrapper = mountTerminal();

    expect(customKeyHandler!(keydown('V', { ctrlKey: true, shiftKey: true }))).toBe(false);
    await settle();

    expect(pasted).toEqual([]);
    wrapper.unmount();
  });
});
