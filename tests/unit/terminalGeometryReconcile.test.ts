// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * The geometry reconcile loop: the interval that asks tmux what size IT thinks
 * the window is, and repairs when the answer disagrees with our grid.
 *
 * This is the failure whose first move happens where nothing local can see it
 * (docs/WORKSPACE.md §14): `window-size latest` means another client of the
 * session — the phone, the user's own terminal — can move the window under us
 * while xterm's grid and TerminalView's `sent` both stay consistent, every
 * existing guard correctly sends nothing, and tmux draws its status line into
 * the middle of a pane full of stale rows until something outside fixes it.
 * The user's workaround was switching workspaces away and back, which re-joins
 * fresh; these tests pin the automatic repair against exactly that class of
 * state.
 *
 * As everywhere else in this directory, jsdom lays nothing out, so these tests
 * assert SCHEDULING: that a disagreement produces one resize-plus-redraw, that
 * agreement and "no answer" produce nothing, and that a pane nobody is looking
 * at spends no round trip at all.
 */

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
    }
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
    attachCustomKeyEventHandler(): void {}
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    // A plausible grid (see MIN_REMOTE_COLS/ROWS), never undefined — undefined
    // would read as the hidden-pane case and skip every path under test.
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 };
    }
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const mockApi = {
  shell: {
    open: vi.fn(async () => 'shell-1'),
    attachSession: vi.fn(async () => ({ shellId: 'shell-1', switched: false })),
    input: vi.fn(async () => true),
    resize: vi.fn(async (_shellId: string, _cols: number, _rows: number) => true),
    redraw: vi.fn(async (_shellId: string) => true),
    close: vi.fn(async () => true),
    // The probe answers agree by default; each test that needs a drift or a
    // refusal overrides this after the baseline drain.
    windowSize: vi.fn(async (): Promise<{ cols: number; rows: number } | null> => ({
      cols: 80,
      rows: 24,
    })),
    onData: vi.fn(() => () => {}),
    onExited: vi.fn(() => () => {}),
  },
};
vi.mock('../../src/renderer/ipc', () => ({ api: mockApi }));

const TerminalView = (await import('../../src/renderer/components/TerminalView.vue')).default;

function setPaneSize(wrapper: VueWrapper, width: number, height: number): void {
  for (const [prop, value] of [
    ['clientWidth', width],
    ['clientHeight', height],
  ] as const) {
    Object.defineProperty(wrapper.element, prop, { value, configurable: true });
  }
}

async function mountTerminal(): Promise<VueWrapper> {
  const wrapper = mount(TerminalView, {
    props: { connectionId: 'conn-1', sessionKey: 'main' },
    attachTo: document.body,
  });
  setPaneSize(wrapper, 800, 600);
  // Drain showTarget() and the trailing startProbing().
  for (let i = 0; i < 10; i++) await nextTick();
  return wrapper;
}

/** Deltas are asserted because the mount itself legitimately sends once. */
const sentCount = (): number => mockApi.shell.resize.mock.calls.length;
const redrawCount = (): number => mockApi.shell.redraw.mock.calls.length;

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the geometry reconcile loop', () => {
  it('does nothing while tmux believes the size we already told it', async () => {
    const wrapper = await mountTerminal();
    const [resizes, redraws] = [sentCount(), redrawCount()];
    expect(resizes).toBeGreaterThan(0); // sanity: the join itself pushed

    await vi.advanceTimersByTimeAsync(20_000); // four ticks of agreement

    expect(sentCount()).toBe(resizes);
    expect(redrawCount()).toBe(redraws);
    wrapper.unmount();
  });

  it('repairs once when the far end reports a drifted window size', async () => {
    // THE reported failure: another client became `window-size latest`, tmux
    // moved its window from 80x24 to something smaller, nothing here changed,
    // and the status line landed mid-pane over stale rows.
    const wrapper = await mountTerminal();
    const [resizes, redraws] = [sentCount(), redrawCount()];
    mockApi.shell.windowSize.mockImplementation(async () => ({ cols: 48, rows: 16 }));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(sentCount()).toBe(resizes + 1);
    expect(redrawCount()).toBe(redraws + 1);
    // Resize without repaint is exactly the half-repair the pool's `redraw`
    // documents: tmux would consider the size change above enough only if it
    // were not ALSO holding a stale picture in rows it stopped owning.
    const [id, cols, rows] = mockApi.shell.resize.mock.calls.at(-1)!;
    expect([cols, rows]).toEqual([80, 24]);
    expect(mockApi.shell.redraw.mock.calls.at(-1)![0]).toBe(id);
    wrapper.unmount();
  });

  it('treats a null answer as quiet, never as an error to react to', async () => {
    // Bare shells get null without ever reaching an exec channel; an evicted
    // tab recovers through scheduleFit instead. Either way this loop must not
    // churn the pane.
    const wrapper = await mountTerminal();
    const [resizes, redraws] = [sentCount(), redrawCount()];
    mockApi.shell.windowSize.mockResolvedValue(null);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(sentCount()).toBe(resizes);
    expect(redrawCount()).toBe(redraws);
    wrapper.unmount();
  });

  it('spends no round trip at all for a pane nobody is looking at', async () => {
    // A v-show'd pane measures zero. Probing behind another tab would be one
    // SSH exec per session per tick — the exact cost shape the channel budget
    // was written against — for a screen no one can see be wrong.
    const wrapper = await mountTerminal();
    setPaneSize(wrapper, 0, 0);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockApi.shell.windowSize).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('spends no round trip while the whole window is obscured', async () => {
    const wrapper = await mountTerminal();
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockApi.shell.windowSize).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    }
    wrapper.unmount();
  });

  it('leaves nothing behind when the answer outlives the tab', async () => {
    // The guard below the await: the answer describes a world that may have
    // moved during the round trip, and a tab closed between ask and reply must
    // not let its corpse push geometry into anything.
    const wrapper = await mountTerminal();
    let releaseProbe!: (value: { cols: number; rows: number }) => void;
    mockApi.shell.windowSize.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseProbe = resolve;
        }),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockApi.shell.windowSize).toHaveBeenCalledTimes(1);

    const resizes = sentCount();
    const redraws = redrawCount();
    wrapper.unmount();
    releaseProbe({ cols: 40, rows: 12 });
    await vi.advanceTimersByTimeAsync(0);

    expect(sentCount()).toBe(resizes);
    expect(redrawCount()).toBe(redraws);
  });
});
