// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { defineComponent, type PropType } from 'vue';
import type { SessionSummary } from '../../src/shared/types';

/**
 * The session panel's creation controls.
 *
 * The user's ask was one sentence — "a `+` near git, near tmp, and just a plus
 * to create a random session in any place; then we don't need 'new session'
 * button anymore" — and it contains a removal, which is what these tests are
 * really guarding. Deleting the foot button is only safe while both `+`s
 * exist, so the properties checked here are:
 *
 *   1. **There is always a way to create a session.** The header's `+` renders
 *      before the session list has loaded, on a host with no sessions at all,
 *      and on a host that failed to resolve `$HOME`. A panel that can show
 *      "no sessions" and no way to make one is the state the removal could
 *      have introduced.
 *   2. **A root's `+` starts the picker IN that root**, expanded to a real
 *      absolute path — not at `$HOME`, and never at the literal `~/git`, which
 *      SFTP would read as a directory named `~`.
 *   3. **`other` has no `+`**, because it is a bucket rather than a directory.
 *   4. **An EMPTY registered root has one**, which is the case the whole
 *      feature is most useful for: a root registered in Settings that nothing
 *      is running in yet.
 *
 * The dialog itself is stubbed. What matters at this seam is which folder it
 * is handed, and NewSessionDialog's own behaviour (browse, derive, start) is
 * not this component's to prove.
 */

const sessionsList = vi.fn<() => Promise<SessionSummary[]>>();
const projectsHome = vi.fn<() => Promise<{ ok: boolean; home?: string; error?: string }>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    // The two calls the panel makes on mount.
    helper: { sessionsList: () => sessionsList() },
    projects: { home: () => projectsHome(), onCloneProgress: vi.fn() },
    // Present because constructing the connection store subscribes to them,
    // not because this component uses them.
    ssh: { onState: vi.fn(), listConfigHosts: vi.fn().mockResolvedValue([]) },
  },
}));

const SessionTree = (await import('../../src/renderer/components/SessionTree.vue')).default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useSettingsStore } = await import('../../src/renderer/stores/settings');

/** Terse SessionSummary factory — only the fields grouping reads. */
function session(name: string, path: string | null, activity = 100): SessionSummary {
  return { name, created: activity, activity, attached: false, path };
}

const HOME = '/home/alexey';

/**
 * The creation dialog, stubbed so its own onMounted browse never runs.
 *
 * Declared as a component rather than inline in `global.stubs` so it can be
 * handed back to `findComponent`: a stub registered only by NAME gets a
 * generated one, and `findComponent({ name: 'NewSessionDialog' })` misses it.
 * `startIn` is what the tests read off it, and it is the whole contract here.
 */
const DialogStub = defineComponent({
  props: { startIn: { type: String as PropType<string | null>, default: undefined } },
  template: '<div class="dialog-stub" />',
});

/**
 * PopupMenu, flattened into the component tree.
 *
 * The real one teleports to `<body>`, which is exactly right in the app and
 * exactly wrong here: a teleported node is outside the wrapper, so every
 * `wrapper.find` in these tests would miss it and the assertions would read as
 * "the menu did not open". What is being checked at this seam is which items a
 * folder row offers and which folder they are pointed at; the teleport and the
 * placement are PopupMenu's own, and popupPlacement.test.ts holds them.
 *
 * Plain options object rather than `defineComponent`, unlike the dialog above:
 * nothing here is ever read back off the instance — the items are found by
 * class — so it needs no identity, and one `defineComponent` per file is the
 * shape the lint rule is asking for.
 */
const MenuStub = {
  props: ['anchor', 'label'],
  template: '<div class="menu-stub" :aria-label="label"><slot /></div>',
};

/**
 * Mount the panel against a host holding `sessions`, with `roots` registered
 * in Settings, and let the two mounted fetches settle.
 */
async function open(
  sessions: SessionSummary[],
  roots: string[] = [],
  home: string | null = HOME,
): Promise<VueWrapper> {
  sessionsList.mockResolvedValue(sessions);
  projectsHome.mockResolvedValue(
    home === null ? { ok: false, error: 'no $HOME' } : { ok: true, home },
  );
  const connection = useConnectionStore();
  connection.connectionId = 'conn-1';
  useSettingsStore().sessionRoots = roots;

  const wrapper = mount(SessionTree, {
    global: { stubs: { NewSessionDialog: DialogStub, PopupMenu: MenuStub } },
  });
  await flush(wrapper);
  return wrapper;
}

async function flush(wrapper: VueWrapper): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  // The poll tests install fake timers BEFORE mounting, because the panel's
  // `setInterval` is created in `onMounted` and one taken out against the real
  // clock cannot be advanced afterwards. That makes the plain `setTimeout(0)`
  // below never fire, so the settle step has to be spelled whichever way the
  // clock currently works.
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

/** The header's general `+` — "a session anywhere". */
function generalAdd(wrapper: VueWrapper): DOMWrapper<Element> {
  return wrapper.find('[title="New session in any folder"]');
}

/** Every control in the header strip, in rendered order, by its title. */
function headerControls(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('.tree-header button')
    .map((b) => b.attributes('title') ?? '');
}

/** Every root row's `+`, in rendered order, with the root it points at. */
function rootAdds(wrapper: VueWrapper): { title: string; disabled: boolean }[] {
  return wrapper.findAll('.root-add').map((b) => ({
    title: b.attributes('title') ?? '',
    disabled: b.attributes('disabled') !== undefined,
  }));
}

/** Every folder row's label, in rendered order. */
function dirLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.dir-header .label').map((l) => l.text());
}

/** The items in the open row menu, with whether each is takeable. */
function menuItems(wrapper: VueWrapper): { text: string; disabled: boolean }[] {
  return wrapper.findAll('.menu-stub .menu-item').map((b) => ({
    text: b.text(),
    disabled: b.attributes('disabled') !== undefined,
  }));
}

/** The stubbed dialog's `startIn`, or `undefined` when it is shut. */
function dialogStartIn(wrapper: VueWrapper): string | null | undefined {
  const stub = wrapper.findComponent(DialogStub);
  return stub.exists() ? stub.props('startIn') : undefined;
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('SessionTree — the foot button is gone, and nothing went with it', () => {
  it('no longer renders the full-width "New session" button', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    expect(wrapper.find('.new-session-btn').exists()).toBe(false);
  });

  it('offers the general + even on a host with no sessions at all', async () => {
    // The state the removal could have stranded: an empty panel used to have
    // exactly one creation control, and it was the one that was deleted.
    const wrapper = await open([]);
    expect(wrapper.find('.empty').text()).toContain('no sessions');
    expect(generalAdd(wrapper).exists()).toBe(true);
  });

  it('offers a worded "New session…" in the empty state, not only the header glyph', async () => {
    // The sentence alone was a dead end: the header's `+` exists but is an
    // unlabelled 14px mark in a strip of five, and an empty panel is exactly
    // when a user has no habits to find it by. The folder workspace's empty
    // state set the pattern — say what is empty AND offer the action in words.
    const wrapper = await open([]);
    const cta = wrapper.find('.empty .btn-ghost');
    expect(cta.exists()).toBe(true);
    expect(cta.text()).toBe('New session…');
    await cta.trigger('click');
    // Null, not `$HOME`: the same contract as the header `+` — one creation
    // flow, entered by a second door.
    expect(dialogStartIn(wrapper)).toBeNull();
  });

  it('opens the picker with nothing pre-selected from the general +', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    expect(dialogStartIn(wrapper)).toBeUndefined();
    await generalAdd(wrapper).trigger('click');
    // Null, not `$HOME`: "any folder" is the dialog's own default behaviour,
    // and pinning it to home here would override a browser the user left
    // somewhere deliberate.
    expect(dialogStartIn(wrapper)).toBeNull();
  });
});

describe('SessionTree — the header strip', () => {
  it('reads back, +, overflow, refresh, settings, hide', async () => {
    // The user's own order for the last four ("here have ... then refresh then
    // settings then hide"), with the `+` leading the actions group because it
    // is the panel's primary action and the rest is chrome.
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    expect(headerControls(wrapper)).toEqual([
      'Back to hosts',
      'New session in any folder',
      'Ports, Usage',
      'Refresh',
      'Settings',
      'Hide session panel',
    ]);
  });

  it('opens Settings from its own control, not only from the overflow menu', async () => {
    const wrapper = await open([]);
    await wrapper.get('[title="Settings"]').trigger('click');
    expect(wrapper.emitted('panel')).toEqual([['settings']]);
  });
});

describe('SessionTree — the per-root +', () => {
  it('puts one on every real root and none on `other`', async () => {
    const wrapper = await open([
      session('git-a', `${HOME}/git/a`, 300),
      session('tmp-b', `${HOME}/tmp/b`, 200),
      session('elsewhere', '/srv/app', 100),
    ]);
    expect(wrapper.findAll('.folder-label').map((l) => l.text())).toEqual(['git', 'tmp', 'other']);
    // Three roots, two `+`s. `other` is where paths that matched no root went;
    // there is no directory for the picker to start in.
    expect(rootAdds(wrapper).map((a) => a.title)).toEqual([
      'New session in ~/git',
      'New session in ~/tmp',
    ]);
  });

  it('hands the picker the root expanded to an absolute path', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    await wrapper.get('.root-add').trigger('click');
    // NOT `~/git`. The dialog browses over SFTP, which runs no shell.
    expect(dialogStartIn(wrapper)).toBe('/home/alexey/git');
  });

  it('works on a registered root with nothing running in it', async () => {
    // A registered root renders even when empty, deliberately — and this is
    // the case the `+` is most useful for, so it must not be conditioned on
    // the root having directories under it.
    const wrapper = await open([session('git-a', `${HOME}/git/a`)], ['~/git', '~/tmp']);
    expect(wrapper.findAll('.empty-root')).toHaveLength(1);
    const adds = wrapper.findAll('.root-add');
    expect(adds).toHaveLength(2);
    await adds[1]!.trigger('click');
    expect(dialogStartIn(wrapper)).toBe('/home/alexey/tmp');
  });

  it('resolves a root registered outside $HOME without rewriting it', async () => {
    const wrapper = await open([session('app', '/srv/apps/x')], ['/srv/apps']);
    await wrapper.get('.root-add').trigger('click');
    expect(dialogStartIn(wrapper)).toBe('/srv/apps');
  });

  it('falls back to the home inferred from the paths when $HOME will not resolve', async () => {
    // Grouping already infers a home rather than dumping everything into
    // `other`; the `+` reads the same inferred value, so the two cannot
    // disagree about which directory `~/git` is.
    const wrapper = await open([session('git-a', `${HOME}/git/a`)], [], null);
    const [add] = rootAdds(wrapper);
    expect(add?.disabled).toBe(false);
    await wrapper.get('.root-add').trigger('click');
    expect(dialogStartIn(wrapper)).toBe('/home/alexey/git');
  });

  it('disables the + rather than hiding it when no home can be found at all', async () => {
    // A registered root on a host whose $HOME failed AND whose sessions offer
    // nothing to infer from. The control stays: a button that vanishes on a
    // failed fetch reads as a feature that is not there, and the title says
    // what went wrong.
    const wrapper = await open([session('nowhere', null)], ['~/git'], null);
    const [add] = rootAdds(wrapper);
    expect(add?.disabled).toBe(true);
    expect(add?.title).toContain('cannot resolve $HOME');
  });
});

/**
 * The folder row's context menu.
 *
 * The gap it closes is one the two `+`s cannot: standing on the row that says
 * `dataqna` and wanting a session IN `dataqna` meant opening the picker at
 * `~/git` and browsing back down to the folder already under the cursor. The
 * row knows its own directory, so the properties here are that it HANDS that
 * directory over, absolute, and that it refuses rather than guesses when it has
 * none.
 */
describe('SessionTree — right-clicking a folder row', () => {
  it('offers a new session in the folder that was right-clicked', async () => {
    const wrapper = await open([
      session('git-dataqna', `${HOME}/git/dataqna`, 300),
      session('git-other', `${HOME}/git/other`, 200),
    ]);
    expect(dirLabels(wrapper)).toEqual(['dataqna', 'other']);
    expect(wrapper.find('.menu-stub').exists()).toBe(false);

    await wrapper.findAll('.dir-header')[0]!.trigger('contextmenu');
    expect(menuItems(wrapper)).toEqual([{ text: 'New session…', disabled: false }]);

    await wrapper.get('.menu-stub .menu-item').trigger('click');
    // The whole point: the picker opens IN the folder, expanded to a real
    // absolute path — never at `$HOME`, and never at the literal `~/git/dataqna`,
    // which SFTP would read as a directory named `~`.
    expect(dialogStartIn(wrapper)).toBe('/home/alexey/git/dataqna');
    // Taking the item closes the menu; two overlapping surfaces is not a state
    // this should be able to reach.
    expect(wrapper.find('.menu-stub').exists()).toBe(false);
  });

  it('acts on the row under the cursor, not on the first one', async () => {
    const wrapper = await open([
      session('git-dataqna', `${HOME}/git/dataqna`, 300),
      session('git-other', `${HOME}/git/other`, 200),
    ]);
    await wrapper.findAll('.dir-header')[1]!.trigger('contextmenu');
    await wrapper.get('.menu-stub .menu-item').trigger('click');
    expect(dialogStartIn(wrapper)).toBe('/home/alexey/git/other');
  });

  it('suppresses the browser default menu', async () => {
    // In a packaged Electron app the default here is Chromium's own menu, which
    // carries nothing that applies to a session row. Dispatched by hand because
    // `trigger` does not hand the event back, and `defaultPrevented` is the only
    // thing that actually proves the `.prevent`.
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    wrapper.get('.dir-header').element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves the row left-click exactly as it was', async () => {
    // The menu is additive. A left-click still opens the folder's workspace,
    // and a right-click still does NOT — a right-click the user then dismisses
    // must not have navigated them somewhere in the meantime.
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    await wrapper.get('.dir-header').trigger('contextmenu');
    expect(wrapper.emitted('select')).toBeUndefined();
    await wrapper.get('.dir-header').trigger('click');
    expect(wrapper.emitted('select')).toHaveLength(1);
  });

  it('disables the item on a folder with no directory on the host', async () => {
    // An untracked session — tmux reported no cwd — is rendered as a folder row
    // labelled by the session name. There is no directory behind it, so there is
    // nowhere to create anything; the item stays, disabled, because `startIn`
    // does not FAIL when it is null, it silently means `$HOME`, and that is a
    // session in the wrong place rather than a session that was not created.
    const wrapper = await open([session('nowhere', null)]);
    expect(dirLabels(wrapper)).toEqual(['nowhere']);
    await wrapper.get('.dir-header').trigger('contextmenu');
    expect(menuItems(wrapper)).toEqual([{ text: 'New session…', disabled: true }]);
    expect(wrapper.get('.menu-stub .menu-item').attributes('title')).toContain(
      'no directory on this host',
    );
    await wrapper.get('.menu-stub .menu-item').trigger('click');
    expect(dialogStartIn(wrapper)).toBeUndefined();
  });
});

/**
 * The panel keeping up with the host, which is what "I stopped the last session
 * and the row stayed" turned out to be about.
 *
 * The grouping never emits a folder with no sessions in it — sessionGrouping's
 * own tests pin that — so a row that outlives its last session is not a
 * projection bug. It is the session list never being re-read: before this, the
 * only `setInterval` in the renderer was the cosmetic clock behind the relative
 * timestamps, while docs/SESSIONLIST.md and docs/WORKSPACE.md argue a dozen
 * decisions against "the refresh timer" that did not exist. A session killed
 * from the phone, from a terminal, or by an agent exiting stayed on screen
 * until the user pressed Refresh.
 */
describe('SessionTree — the panel keeps up with the host', () => {
  // Installed before the mount on purpose: the interval is created in
  // `onMounted`, and one taken out against the real clock cannot be advanced.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a folder row once its last session is gone from the host', async () => {
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    expect(dirLabels(wrapper)).toEqual(['dataqna']);

    // The session was stopped — here, from the phone, or from the user's own
    // terminal. The panel is told nothing; it has to notice.
    sessionsList.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(5_000);
    await wrapper.vm.$nextTick();

    expect(dirLabels(wrapper)).toEqual([]);
    expect(wrapper.find('.empty').text()).toContain('no sessions');
  });

  it('keeps the other sessions in a folder when only one of them goes', async () => {
    // The removal must be driven by what the host reports and nothing else. A
    // folder losing one of two sessions keeps its row, with the survivor in it.
    const wrapper = await open([
      session('git-dataqna', `${HOME}/git/dataqna`, 300),
      session('git-dataqna-2', `${HOME}/git/dataqna`, 200),
    ]);
    sessionsList.mockResolvedValue([session('git-dataqna', `${HOME}/git/dataqna`, 300)]);
    await vi.advanceTimersByTimeAsync(5_000);
    await wrapper.vm.$nextTick();

    expect(dirLabels(wrapper)).toEqual(['dataqna']);
  });

  it('keeps the row AND says why when the list cannot be re-read', async () => {
    // The failure mode the user could not interpret. Blanking the tree on one
    // bad round trip would be worse than showing a list a few seconds old, so
    // the row stays — and the message is then the only thing standing between
    // the user and a tree they have no reason to distrust.
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    sessionsList.mockRejectedValue(new Error('ssh channel closed'));
    await vi.advanceTimersByTimeAsync(5_000);
    await wrapper.vm.$nextTick();

    expect(dirLabels(wrapper)).toEqual(['dataqna']);
    expect(wrapper.get('.error').text()).toContain('ssh channel closed');
  });

  it('polls quietly, without spinning the Refresh glyph', async () => {
    // `loading` is not "a request is in flight", it is "the user asked and is
    // waiting". A poll that set it would spin that glyph and grey the button
    // out for a moment every few seconds forever, which reads as a panel
    // permanently working rather than one quietly keeping up.
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    // Left pending, so the assertion lands while the listing is genuinely out.
    sessionsList.mockReturnValue(new Promise<SessionSummary[]>(() => {}));
    await vi.advanceTimersByTimeAsync(5_000);
    await wrapper.vm.$nextTick();

    const refresh = wrapper.get('[title="Refresh"]');
    expect(refresh.attributes('disabled')).toBeUndefined();
    expect(refresh.find('.spin').exists()).toBe(false);
  });

  it('does not stack listings on a host slower than the poll', async () => {
    // Five seconds is shorter than a round trip over a bad link, and without
    // the in-flight guard every tick would put another pair of execs on a
    // connection that is already struggling.
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    const listedOnMount = sessionsList.mock.calls.length;
    sessionsList.mockReturnValue(new Promise<SessionSummary[]>(() => {}));
    await vi.advanceTimersByTimeAsync(30_000);
    await wrapper.vm.$nextTick();
    expect(sessionsList.mock.calls.length).toBe(listedOnMount + 1);
  });

  it('stops asking once main has declared the transport lost', async () => {
    // Each tick against a dead link fails, and the failure is not quiet — it
    // rewrites `sessions.error` with a raw IPC message every five seconds,
    // forever, over the top of the one report the drop already produced. A
    // poll cannot revive a dead transport; only the reconnect can, so a lost
    // link is a skip exactly like a hidden window.
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    const listedOnMount = sessionsList.mock.calls.length;
    useConnectionStore().state = 'lost';
    await vi.advanceTimersByTimeAsync(30_000);
    await wrapper.vm.$nextTick();
    expect(sessionsList.mock.calls.length).toBe(listedOnMount);
    // The stale rows stay: a tree a few seconds old beats a blank panel while
    // the link is being re-dialled.
    expect(dirLabels(wrapper)).toEqual(['dataqna']);
  });

  it('stops polling once the panel goes away', async () => {
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    wrapper.unmount();
    const after = sessionsList.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionsList.mock.calls.length).toBe(after);
  });
});
