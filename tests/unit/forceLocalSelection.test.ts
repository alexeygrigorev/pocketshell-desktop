// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Plain drag must select in the pane even while the remote owns the mouse.
 *
 * The report this pins: "I still can't select code in the terminal — I have a
 * use case where I want to copy-paste something and the highlight
 * disappears". The highlight belonged to TMUX: with mouse reporting on, xterm
 * handed button events to the remote, tmux ran its copy-mode selection, and
 * its drag-end (`copy-pipe; cancel`) dismissed the highlight the instant the
 * button went up. Commit e0e0a68 made that yank reach the clipboard through
 * OSC 52, but nothing on screen ever said so — from the user's seat selection
 * was still broken.
 *
 * The fix replaces xterm's `SelectionService.shouldForceSelection` predicate
 * — the one hook its own code consults before reporting a mousedown — so a
 * plain button-1 press forces the LOCAL selection service (which then drags
 * and persists normally), and SHIFT keeps the old behaviour: the gesture goes
 * to tmux, whose yank arrives as OSC 52. terminalMouseSelection.ts documents
 * the mechanism and the shape-checked private-API access.
 *
 * The wiring test below pins that TerminalView actually applies the patch at
 * mount, because the failure shape of this fix is silence: a future xterm
 * upgrade that renames `_core._selectionService` would quietly hand the
 * vanishing gesture back, exactly the class of dead-by-upgrade failure the
 * diag record in the component exists to catch.
 */

import { forceLocalMouseSelection } from '../../src/renderer/terminalMouseSelection';

/** A predicate with xterm's real off-macOS semantics, as shipped in 6.0.0. */
const stockShouldForce = (event: MouseEvent): boolean => event.shiftKey;

function fakeTerm(shouldForce: unknown): unknown {
  return { _core: { _selectionService: { shouldForceSelection: shouldForce } } };
}

function mouse(shift: boolean): MouseEvent {
  return new MouseEvent('mousedown', { shiftKey: shift, bubbles: true });
}

describe('forceLocalMouseSelection — the predicate', () => {
  it('makes a PLAIN button-1 press force local selection', () => {
    const term = fakeTerm(stockShouldForce);
    expect(forceLocalMouseSelection(term)).toBe(true);
    const svc = (term as { _core: { _selectionService: { shouldForceSelection: (e: MouseEvent) => boolean } } })
      ._core._selectionService;
    expect(svc.shouldForceSelection(mouse(false))).toBe(true);
  });

  it('keeps SHIFT as the hand-off to the remote', () => {
    // Shift is the deliberate escape hatch back to tmux's own mouse
    // gestures (copy-mode drag with its OSC 52 yank, pane focus in splits).
    const term = fakeTerm(stockShouldForce);
    forceLocalMouseSelection(term);
    const svc = (term as { _core: { _selectionService: { shouldForceSelection: (e: MouseEvent) => boolean } } })
      ._core._selectionService;
    expect(svc.shouldForceSelection(mouse(true))).toBe(false);
  });

  it('replaces the stock predicate rather than wrapping it', () => {
    // The stock answer (shiftKey) must not survive anywhere in the decision:
    // a wrapper that consulted it first would let Shift's old meaning leak.
    const term = fakeTerm(stockShouldForce);
    forceLocalMouseSelection(term);
    const svc = (term as { _core: { _selectionService: { shouldForceSelection: unknown } } })
      ._core._selectionService;
    expect(svc.shouldForceSelection).not.toBe(stockShouldForce);
  });

  it('answers false and throws nothing on every mismatched shape', () => {
    const shapes: unknown[] = [
      undefined,
      null,
      42,
      {},
      { _core: null },
      { _core: {} },
      { _core: { _selectionService: null } },
      { _core: { _selectionService: undefined } },
      { _core: { _selectionService: 'not an object' } },
      { _core: { _selectionService: {} } },
      { _core: { _selectionService: { shouldForceSelection: 42 } } },
      { _core: { _selectionService: { shouldForceSelection: null } } },
    ];
    for (const shape of shapes) {
      expect(forceLocalMouseSelection(shape)).toBe(false);
    }
  });

  it('is safe to call twice — the patch re-applies and keeps working', () => {
    const term = fakeTerm(stockShouldForce);
    expect(forceLocalMouseSelection(term)).toBe(true);
    expect(forceLocalMouseSelection(term)).toBe(true);
    const svc = (term as { _core: { _selectionService: { shouldForceSelection: (e: MouseEvent) => boolean } } })
      ._core._selectionService;
    expect(svc.shouldForceSelection(mouse(false))).toBe(true);
    expect(svc.shouldForceSelection(mouse(true))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The wiring: TerminalView applies the patch at mount
// ---------------------------------------------------------------------------

/** Set by the fake terminal; holds the service the component must have patched. */
let selectionService: { shouldForceSelection: (e: MouseEvent) => boolean } | null = null;

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    reset(): void {}
    write(): void {}
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
    parser = {
      registerOscHandler(): { dispose: () => void } {
        return { dispose: () => {} };
      },
    };
    attachCustomKeyEventHandler(): void {}
    constructor() {
      selectionService = { shouldForceSelection: stockShouldForce };
      (this as { _core?: unknown })._core = { _selectionService: selectionService };
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
    diag: {
      log: vi.fn(),
    },
  },
}));

describe('TerminalView applies the patch at mount', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    selectionService = null;
  });

  it('replaces the selection predicate on the terminal it mounts', async () => {
    const TerminalView = (await import('../../src/renderer/components/TerminalView.vue')).default;
    const wrapper = mount(TerminalView, {
      props: { connectionId: 'conn-1', sessionKey: 'main' },
      attachTo: document.body,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(selectionService).not.toBeNull();
    expect(selectionService!.shouldForceSelection).not.toBe(stockShouldForce);
    expect(selectionService!.shouldForceSelection(mouse(false))).toBe(true);
    expect(selectionService!.shouldForceSelection(mouse(true))).toBe(false);
    wrapper.unmount();
  });
});
