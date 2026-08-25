// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    global: { stubs: { NewSessionDialog: DialogStub } },
  });
  await flush(wrapper);
  return wrapper;
}

async function flush(wrapper: VueWrapper): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
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
