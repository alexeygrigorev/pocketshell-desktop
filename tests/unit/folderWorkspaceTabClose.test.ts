// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * The `×` on a session tab (docs/WORKSPACE.md §14).
 *
 * The user asked for "x here like in vscode", and the two rules this file pins
 * are what the ask changed and what it did NOT:
 *
 *  - the stop the tab menu owned is now reachable from the tab itself;
 *  - it still cannot kill. It arms the same confirmed dialog the right-click
 *    menu does, says Stop rather than Close, and does not select the tab it
 *    sits on — the right-click rule, which a mis-aimed click on a background
 *    tab must not be able to violate.
 *
 * The kill ITSELF is `confirmStop` and is out of scope here: this file asserts
 * the arm and the cancel, with `projects.killSession` spied to prove the `×`
 * alone destroys nothing.
 */

const route = ref({ params: { name: 'host', folder: '~/git/x' }, query: {} });

vi.mock('vue-router', () => ({
  useRoute: () => route.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const killSession = vi.fn().mockResolvedValue({ ok: true });

const overrides: Record<string, unknown> = {
  'helper.usage': vi.fn().mockResolvedValue([]),
  'helper.sessionsList': vi.fn().mockResolvedValue([]),
  'agent.profiles': vi.fn().mockResolvedValue([]),
  'ssh.listConfigHosts': vi.fn().mockResolvedValue([]),
  'projects.home': vi.fn().mockResolvedValue({ ok: true, home: '/home/me', error: null }),
  'projects.killSession': killSession,
  'preview.onStats': () => () => undefined,
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
const { useProjectsStore } = await import('../../src/renderer/stores/projects');

const stubs = {
  // `focus` is part of the real TerminalView's exposed surface and is what a
  // tab close lands on through `focusActiveTab`; a bare div stub would leave
  // that call throwing as an unhandled rejection.
  TerminalView: { template: '<div class="stub-terminal" />', methods: { focus: () => undefined } },
  PromptComposer: { template: '<div class="stub-composer" />' },
  FilesView: { template: '<div class="stub-files" />' },
  OverlayPanel: { template: '<div class="stub-overlay"><slot /></div>' },
  PopupMenu: { template: '<div><slot /></div>' },
  LaunchSessionDialog: { template: '<div />' },
};

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function openWorkspace(): Promise<VueWrapper> {
  const wrapper = mount(FolderWorkspaceView, { global: { stubs } });
  await flush();
  return wrapper;
}

function tabLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('nav.tabs button').map((b) => b.text().trim());
}

function activeLabel(wrapper: VueWrapper): string {
  return wrapper.find('nav.tabs button.active').text().trim();
}

/** The `×` of the tab whose label is [label]. */
function closeOf(wrapper: VueWrapper, label: string): ReturnType<VueWrapper['find']> {
  const tab = wrapper
    .findAll('nav.tabs button')
    .find((b) => b.text().includes(label))
    ;
  if (!tab) throw new Error(`no tab labelled ${label}`);
  return tab.find('.tab-close');
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  killSession.mockClear();
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
  useSessionsStore().sessions = [
    { name: 'git-x', created: 1, activity: 1, attached: false, path: '/home/me/git/x' },
  ] as never;
});

describe('the close control on a session tab', () => {
  it('says Stop and opens the named confirmation, killing nothing', async () => {
    const wrapper = await openWorkspace();
    expect(tabLabels(wrapper)).toEqual(['Terminal', 'Files']);

    expect(closeOf(wrapper, 'Terminal').attributes('title')).toBe('Stop this session');
    await closeOf(wrapper, 'Terminal').trigger('click');
    await flush();

    const confirm = wrapper.find('.stub-overlay');
    expect(confirm.exists()).toBe(true);
    expect(confirm.text()).toContain('git-x');
    expect(killSession).not.toHaveBeenCalled();
  });

  it('does not move the user to a background tab whose × they clicked', async () => {
    const wrapper = await openWorkspace();
    // A second session, so the Terminal tab has a background sibling to click
    // at. Without it the tab is the active one and the assertion is vacuous.
    useSessionsStore().sessions.push({
      name: 'git-x-2',
      created: 2,
      activity: 2,
      attached: false,
      path: '/home/me/git/x',
    });
    await flush();
    expect(activeLabel(wrapper)).toBe('Terminal');

    await closeOf(wrapper, 'Terminal 2').trigger('click');
    await flush();

    expect(activeLabel(wrapper)).toBe('Terminal');
    expect(wrapper.find('.stub-overlay').text()).toContain('git-x-2');
  });
});
