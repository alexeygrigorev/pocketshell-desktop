// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * `Ctrl+←` / `Ctrl+→` — the tab to the left, the tab to the right.
 *
 * Asked for in those words: "ctrl left goes to the left tab right to the right
 * tab", with `Ctrl+↑`/`Ctrl+↓` for the workspaces (`workspaceStepChord.test.ts`
 * holds that half). The pairing is the design — horizontal is the tab bar,
 * vertical is the panel down the side — so the two files pin one gesture
 * between them and the rules they share are asserted in both.
 *
 * What is pinned here:
 *
 *   1. **Direction**, and that it acts on the ACTIVE tab rather than the first.
 *   2. **It CLAMPS**, where `Ctrl+Tab` wraps. Tab is a cycle; an arrow is a
 *      direction, and being thrown to the far end is not what "further left"
 *      asked for. This is the one property a future edit is most likely to
 *      "fix" by reaching for `nextWorkspaceTabId`.
 *   3. **The keystroke is cancelled**, both ways — `preventDefault` so Chromium
 *      does not also act, `stopPropagation` so it never reaches xterm's
 *      textarea, where `Ctrl+←` is `ESC [ 1 ; 5 D`. One keystroke, two paths,
 *      is the defect that has landed in this app three times (bc86cf7,
 *      3628090, and the Ctrl+V route after them).
 *   4. **A real text field keeps its word-jump** — but the TERMINAL is not one,
 *      even though xterm's input sink is literally a `<textarea>`. That
 *      exception is the whole feature: a naive editable test would exempt the
 *      one surface these chords exist for.
 *   5. **The removed families stay removed.** `Ctrl+1`..`Ctrl+9` and
 *      `Ctrl+Shift+PageUp`/`PageDown` were dropped at the user's request, and
 *      what proves it here is that the workspace no longer CANCELS them: the
 *      keys have to reach the pane, where they are C0 controls and xterm's
 *      scrollback.
 *
 * Mounting, stubbing and the ipc Proxy follow folderWorkspaceRename.test.ts
 * exactly; see the reasoning there.
 */

const route = ref({ params: { name: 'host', folder: '~/git/x' }, query: {} });
const routerPush = vi.fn();

vi.mock('vue-router', () => ({
  useRoute: () => route.value,
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
}));

const sessionsList = vi.fn<(...args: unknown[]) => Promise<unknown>>();

const overrides: Record<string, unknown> = {
  'helper.usage': vi.fn().mockResolvedValue([]),
  'helper.sessionsList': (...a: unknown[]) => sessionsList(...a),
  'agent.profiles': vi.fn().mockResolvedValue([]),
  'ssh.listConfigHosts': vi.fn().mockResolvedValue([]),
  'projects.home': vi.fn().mockResolvedValue({ ok: true, home: '/home/me', error: null }),
};

function channel(group: string): unknown {
  return new Proxy(
    {},
    {
      get: (_t, key: string) =>
        overrides[`${group}.${key}`] ?? ((): Promise<unknown> => Promise.resolve(undefined)),
    },
  );
}

vi.mock('../../src/renderer/ipc', () => ({
  api: new Proxy({}, { get: (_t, key: string) => channel(key) }),
}));

const FolderWorkspaceView = (await import('../../src/renderer/views/FolderWorkspaceView.vue'))
  .default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useSessionsStore } = await import('../../src/renderer/stores/sessions');

function row(name: string, created: number): unknown {
  return {
    name,
    created,
    activity: created,
    attached: false,
    path: '/home/me/git/x',
    agentKind: null,
  };
}

const stubs = {
  TerminalView: { template: '<div class="stub-terminal" />' },
  PromptComposer: { template: '<div class="stub-composer" />' },
  FilesView: { template: '<div class="stub-files" />' },
  OverlayPanel: { template: '<div><slot /></div>' },
  PopupMenu: { template: '<div><slot /></div>' },
  LaunchSessionDialog: { template: '<div class="stub-launch" />' },
};

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Mount on a folder holding three sessions, so there is a tab to each side of
 * the middle one and a wall at each end.
 */
async function openWorkspace(): Promise<VueWrapper> {
  const wrapper = mount(FolderWorkspaceView, { global: { stubs }, attachTo: document.body });
  await flush();
  return wrapper;
}

/** The labels on the tab bar, in order. */
function tabLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('nav.tabs button.tab').map((b) => b.text().trim());
}

/** The label of the tab that is currently selected. */
function activeTab(wrapper: VueWrapper): string {
  return wrapper.find('nav.tabs button.tab.active').text().trim();
}

/**
 * Select a tab by its label, the way a user does.
 *
 * A click on the tab that is ALREADY active is deliberately skipped, because in
 * this app that gesture is not a selection — it opens the inline rename (§4.3),
 * which swaps the button for a field and makes the chord handler stand down
 * (`renaming !== null`). Clicking it "just to be sure" would silently put every
 * test that did so into a state where nothing responds to the keyboard.
 */
async function clickTab(wrapper: VueWrapper, label: string): Promise<void> {
  if (activeTab(wrapper) === label) return;
  const tab = wrapper.findAll('nav.tabs button.tab').find((b) => b.text().trim() === label);
  if (!tab) throw new Error(`no tab labelled ${label} in: ${tabLabels(wrapper).join(', ')}`);
  await tab.trigger('click');
  await flush(2);
}

/**
 * Press a chord the way the browser delivers one: on `window`, in the capture
 * phase, from a target inside the page. The handler is a window capture
 * listener precisely so it runs before xterm, CodeMirror and the composer, and
 * dispatching anywhere else would test a listener the app does not have.
 */
async function press(
  wrapper: VueWrapper,
  key: string,
  mods: Partial<KeyboardEventInit> = {},
  target?: HTMLElement,
): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    cancelable: true,
    bubbles: true,
    ...mods,
  });
  (target ?? (wrapper.element as HTMLElement)).dispatchEvent(e);
  await flush(2);
  return e;
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.clearAllMocks();
  route.value = { params: { name: 'host', folder: '~/git/x' }, query: {} };
  sessionsList.mockResolvedValue([row('git-x', 3), row('git-x-2', 2), row('git-x-3', 1)]);
  const connection = useConnectionStore();
  connection.connectionId = 'conn-1';
  useSessionsStore().sessions = [] as never[];
});

describe('Ctrl+Left / Ctrl+Right step one tab', () => {
  it('moves to the tab on the side that was pressed', async () => {
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    expect(labels.length).toBeGreaterThanOrEqual(3);

    await clickTab(wrapper, labels[1]!);
    expect(activeTab(wrapper)).toBe(labels[1]);

    await press(wrapper, 'ArrowRight');
    expect(activeTab(wrapper)).toBe(labels[2]);

    await press(wrapper, 'ArrowLeft');
    expect(activeTab(wrapper)).toBe(labels[1]);
    wrapper.unmount();
  });

  it('STOPS at the wall instead of wrapping round', async () => {
    // The property most likely to be "fixed" by a future edit reaching for
    // `nextWorkspaceTabId`, which cycles for Ctrl+Tab. An arrow is a direction:
    // being thrown to the opposite end of the bar loses the position the key
    // exists to preserve.
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);

    await clickTab(wrapper, labels[0]!);
    await press(wrapper, 'ArrowLeft');
    expect(activeTab(wrapper)).toBe(labels[0]);

    await clickTab(wrapper, labels[labels.length - 1]!);
    await press(wrapper, 'ArrowRight');
    expect(activeTab(wrapper)).toBe(labels[labels.length - 1]);
    wrapper.unmount();
  });

  it('cancels the keystroke, so the shell never also receives it', async () => {
    // xterm encodes Ctrl+← as ESC [ 1 ; 5 D, which readline reads as
    // backward-word. Without the cancel the chord would move the tab AND jump a
    // word at the prompt — one keystroke, two paths.
    const wrapper = await openWorkspace();
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      const e = await press(wrapper, key);
      expect(e.defaultPrevented, key).toBe(true);
    }
    wrapper.unmount();
  });

  it('takes the Cmd spelling, and leaves AltGr alone', async () => {
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    await clickTab(wrapper, labels[0]!);

    await press(wrapper, 'ArrowRight', { ctrlKey: false, metaKey: true });
    expect(activeTab(wrapper)).toBe(labels[1]);

    // Ctrl+Alt is AltGr on European layouts; it is not this chord.
    const e = await press(wrapper, 'ArrowRight', { altKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(activeTab(wrapper)).toBe(labels[1]);
    wrapper.unmount();
  });
});

describe('where the tab arrows stand down', () => {
  it('leaves a real text field its word-jump', async () => {
    // Ctrl+arrow is backward-word / forward-word in every text field on every
    // platform, and this app has several the user types prose into. Taking the
    // chord from those would trade an editing gesture people have had for
    // decades for a navigation one.
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    await clickTab(wrapper, labels[0]!);

    const field = document.createElement('textarea');
    document.body.appendChild(field);
    const e = await press(wrapper, 'ArrowRight', {}, field);

    expect(e.defaultPrevented).toBe(false);
    expect(activeTab(wrapper)).toBe(labels[0]);
    field.remove();
    wrapper.unmount();
  });

  it('does NOT treat the terminal as a text field, though xterm’s sink is one', async () => {
    // THE EXCEPTION THE FEATURE RESTS ON. xterm's input sink is a real
    // `<textarea class="xterm-helper-textarea">`, focused whenever the pane has
    // the keyboard — so a plain editable check would exempt the terminal, and
    // the chord would appear to do nothing in the one place it is for.
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    await clickTab(wrapper, labels[0]!);

    const pane = document.createElement('div');
    pane.className = 'xterm';
    const sink = document.createElement('textarea');
    sink.className = 'xterm-helper-textarea';
    pane.appendChild(sink);
    document.body.appendChild(pane);

    const e = await press(wrapper, 'ArrowRight', {}, sink);
    expect(e.defaultPrevented).toBe(true);
    expect(activeTab(wrapper)).toBe(labels[1]);
    pane.remove();
    wrapper.unmount();
  });
});

describe('the families that were removed stay removed', () => {
  it('lets Ctrl+1..Ctrl+9 through to the pane', async () => {
    // "remove ctrl 1 2 3 hotkey". The workspace must no longer cancel them:
    // Ctrl+3..Ctrl+7 are ESC, FS, GS, RS, US at a terminal and Ctrl+8 is DEL,
    // and a chord this app does not claim has to reach the program the user is
    // talking to.
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    await clickTab(wrapper, labels[0]!);

    for (const digit of ['1', '2', '3', '9']) {
      const e = await press(wrapper, digit);
      expect(e.defaultPrevented, digit).toBe(false);
    }
    expect(activeTab(wrapper)).toBe(labels[0]);
    wrapper.unmount();
  });

  it('lets Ctrl+Shift+PageUp / PageDown through to xterm’s scrollback', async () => {
    // "Move the active tab left or right remove this too". The drag still
    // reorders (docs/WORKSPACE.md §15); the keys belong to the pane again.
    const wrapper = await openWorkspace();
    const before = tabLabels(wrapper);

    for (const key of ['PageUp', 'PageDown']) {
      const e = await press(wrapper, key, { shiftKey: true });
      expect(e.defaultPrevented, key).toBe(false);
    }
    expect(tabLabels(wrapper)).toEqual(before);
    wrapper.unmount();
  });

  it('keeps Ctrl+Tab cycling, which is NOT what the arrows do', async () => {
    // The two coexist on purpose and differ at the wall: Tab wraps, the arrows
    // clamp. Asserted here so a future tidy-up cannot quietly make them the
    // same chord twice.
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    await clickTab(wrapper, labels[labels.length - 1]!);

    await press(wrapper, 'Tab');
    expect(activeTab(wrapper)).toBe(labels[0]);
    wrapper.unmount();
  });
});
