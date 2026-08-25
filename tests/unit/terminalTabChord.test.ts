// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The tab chords must not reach the shell (docs/WORKSPACE.md §11).
 *
 * ## The premise this file exists to correct
 *
 * `Ctrl+Tab` and `Ctrl+1..9` were chosen on the grounds that "terminals cannot
 * encode them". Measured against the xterm this app actually ships
 * (`@xterm/xterm` 6, `evaluateKeyboardEvent`, which is the function
 * `attachCustomKeyEventHandler` is consulted from), that is FALSE for most of
 * the family:
 *
 *     Ctrl+Tab        -> C0.HT (`\t`)     `case 9` is reached before any ctrl
 *                                          branch and is gated only on Shift,
 *                                          so the modifier is ignored outright
 *     Ctrl+Shift+Tab  -> ESC [ Z          back-tab
 *     Ctrl+3 .. Ctrl+7 -> ESC, FS, GS, RS, US
 *                                          keyCodes 51-55 map to
 *                                          `keyCode - 51 + 27` in the ctrl arm
 *     Ctrl+8          -> C0.DEL
 *     Ctrl+1, Ctrl+2, Ctrl+9 -> nothing
 *
 * So the chords are not free. `Ctrl+Tab` at a shell prompt is completion, and
 * `Ctrl+3` is a widely used stand-in for Escape. The family is still worth
 * taking — the user asked for it, and a family with holes in it would be worse
 * than the cost — but the interception has to be airtight rather than merely
 * tidy, and that is what these cases pin.
 *
 * ## Two layers, and this file tests the second
 *
 * The chord is HANDLED by a window-level capture listener in
 * FolderWorkspaceView, which stops the event before it descends to xterm's
 * textarea. That is the layer that makes the chord work identically with focus
 * in the terminal, the Files tree or the composer.
 *
 * This handler is the second layer, and it is not decoration: a TerminalView
 * mounted outside a folder workspace has no such listener above it, and without
 * this branch the chord would become shell input there. Declining it here means
 * the chord's meaning does not depend on who mounted the pane.
 *
 * ## Why `defaultPrevented` and not a byte count
 *
 * The same reason terminalPasteChord.test.ts gives: jsdom performs no default
 * action, so it cannot reproduce the second path. What it CAN assert is the
 * thing that makes the second path impossible — and returning false alone is
 * not that thing, because xterm's `_keyDown` bails at the custom handler and
 * never calls its own `cancel()`. That omission is bc86cf7's doubled first
 * letter and 3628090's doubled paste; this is the third chord family to have to
 * say so.
 */

/** Captures the handler TerminalView hands to xterm, so a test can drive it. */
let customKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    reset(): void {}
    write(): void {}
    paste(): void {}
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

function keydown(key: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...mods });
}

function mountTerminal() {
  return mount(TerminalView, {
    props: { connectionId: 'conn-1', sessionKey: 'main', interceptTyping: false },
    attachTo: document.body,
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  customKeyHandler = null;
});

describe('the tab chords are taken away from xterm', () => {
  it('CANCELS Ctrl+Tab, which xterm would otherwise send as a literal TAB', () => {
    const wrapper = mountTerminal();
    const e = keydown('Tab', { ctrlKey: true });

    expect(customKeyHandler).not.toBeNull();
    expect(customKeyHandler!(e)).toBe(false);
    // Both halves. Returning false stops xterm; preventDefault stops Chromium,
    // which has its own Ctrl+Tab.
    expect(e.defaultPrevented).toBe(true);
    wrapper.unmount();
  });

  it('CANCELS Ctrl+Shift+Tab, which xterm would send as ESC [ Z', () => {
    const wrapper = mountTerminal();
    const e = keydown('Tab', { ctrlKey: true, shiftKey: true });

    expect(customKeyHandler!(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    wrapper.unmount();
  });

  it('cancels every digit in the family, including the ones xterm encodes', () => {
    // Ctrl+3..Ctrl+8 are real C0 control bytes at a terminal. They are the
    // reason this branch cannot be "only the ones that do nothing anyway".
    const wrapper = mountTerminal();
    for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      const e = keydown(digit, { ctrlKey: true });
      expect(customKeyHandler!(e)).toBe(false);
      expect(e.defaultPrevented).toBe(true);
    }
    wrapper.unmount();
  });

  it('takes the Cmd spelling too', () => {
    const wrapper = mountTerminal();
    for (const e of [keydown('Tab', { metaKey: true }), keydown('4', { metaKey: true })]) {
      expect(customKeyHandler!(e)).toBe(false);
      expect(e.defaultPrevented).toBe(true);
    }
    wrapper.unmount();
  });

  it('acts on the keydown only, never on keypress or keyup', () => {
    // xterm consults this handler for all three. The chord is one keystroke.
    const wrapper = mountTerminal();
    for (const type of ['keypress', 'keyup']) {
      const e = new KeyboardEvent(type, { key: 'Tab', ctrlKey: true, cancelable: true });
      expect(customKeyHandler!(e)).toBe(true);
      expect(e.defaultPrevented).toBe(false);
    }
    wrapper.unmount();
  });
});

describe('what the chords deliberately leave alone', () => {
  it('lets a BARE Tab through — that is completion at a shell prompt', () => {
    const wrapper = mountTerminal();
    for (const e of [keydown('Tab'), keydown('Tab', { shiftKey: true })]) {
      expect(customKeyHandler!(e)).toBe(true);
      expect(e.defaultPrevented).toBe(false);
    }
    wrapper.unmount();
  });

  it('lets a bare digit through', () => {
    const wrapper = mountTerminal();
    const e = keydown('4');
    expect(customKeyHandler!(e)).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    wrapper.unmount();
  });

  it('leaves Ctrl+Shift+<digit> alone — a different chord, and nobody’s here', () => {
    // Only Tab takes Shift, as its direction. A shifted digit is punctuation on
    // most layouts and is not part of the jump family.
    const wrapper = mountTerminal();
    const e = keydown('4', { ctrlKey: true, shiftKey: true });
    expect(customKeyHandler!(e)).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    wrapper.unmount();
  });

  it('leaves Ctrl+Alt alone — that is AltGr on European layouts', () => {
    // The digit row carries printable characters under AltGr on several
    // layouts. Same guard the Ctrl+V branch already carries.
    const wrapper = mountTerminal();
    for (const e of [
      keydown('Tab', { ctrlKey: true, altKey: true }),
      keydown('4', { ctrlKey: true, altKey: true }),
    ]) {
      expect(customKeyHandler!(e)).toBe(true);
      expect(e.defaultPrevented).toBe(false);
    }
    wrapper.unmount();
  });

  it('leaves Ctrl+0 alone — it belongs to zoom, and there is no zeroth tab', () => {
    const wrapper = mountTerminal();
    const e = keydown('0', { ctrlKey: true });
    expect(customKeyHandler!(e)).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    wrapper.unmount();
  });
});

/**
 * A press in the pane is the plain-terminal hatch (docs/COMPOSER.md §12.2).
 *
 * Escape used to suppress the typing intercept; the user reported that as a bug
 * and it moved to the one gesture that unambiguously means "I am typing at the
 * shell". This component only reports the press — what it MEANS is the
 * workspace's decision — so what there is to assert here is that it reports it
 * at all, and for every button.
 */
describe('a press in the pane is announced', () => {
  it('emits on a left press', () => {
    const wrapper = mountTerminal();
    const target = wrapper.element as HTMLElement;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(wrapper.emitted('pressed')).toHaveLength(1);
    wrapper.unmount();
  });

  it('emits on a RIGHT press too — that one pastes into the shell', () => {
    const wrapper = mountTerminal();
    const target = wrapper.element as HTMLElement;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    expect(wrapper.emitted('pressed')).toHaveLength(1);
    wrapper.unmount();
  });
});
