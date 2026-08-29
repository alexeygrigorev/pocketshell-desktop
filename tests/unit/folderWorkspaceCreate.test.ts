// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import type { LaunchChoice } from '../../src/shared/agentLaunch';

/**
 * The folder workspace's `+` -> "New session…" -> Create session, tested for
 * the one property it lost and the one it never had.
 *
 * The bug: the host can answer a `unique` start with the name of a session this
 * bar is ALREADY showing (ProjectsService.startSession has the socket-blindness
 * that made it do so), and this view trusted the name it was handed. With
 * Session type = Shell that assigned `selected` the tab that was already
 * selected, so the dialog closed and nothing visibly happened. With an agent
 * chosen it armed the launch against a session whose PTY was already up and
 * registered, so the launch watcher fired immediately and typed
 * `pocketshell agent …` into the terminal the user was working in.
 *
 * So the two things asserted here are:
 *
 *   1. **a genuinely new name gets a genuinely new tab**, and an agent launch
 *      goes into THAT session's shell and no other;
 *   2. **a name that is already on the bar is refused out loud** — nothing is
 *      typed anywhere, nothing is re-selected, and `createError` renders.
 *
 * `LaunchSessionDialog` is stubbed down to two buttons on purpose. What is
 * under test is what the WORKSPACE does with a confirmed choice; the dialog's
 * own validation is pinned in LaunchSessionDialog.test.ts, and driving its real
 * controls from here would make this file fail whenever a label moved.
 */

const route = ref({ params: { name: 'host', folder: '~/git/x' }, query: {} });

vi.mock('vue-router', () => ({
  useRoute: () => route.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const startSession = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const sessionsList = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const shellInput = vi.fn<(...args: unknown[]) => Promise<unknown>>();

/**
 * The renderer api, as a Proxy.
 *
 * This view constructs seven stores between them touching a dozen channels,
 * most of which only need to exist. Spelling every one out would bury the four
 * that carry the behaviour, so anything not named here answers
 * `Promise<undefined>` and the named ones are the test's subject.
 */
const overrides: Record<string, unknown> = {
  'helper.usage': vi.fn().mockResolvedValue([]),
  'helper.sessionsList': (...a: unknown[]) => sessionsList(...a),
  'agent.profiles': vi.fn().mockResolvedValue([]),
  'ssh.listConfigHosts': vi.fn().mockResolvedValue([]),
  'projects.startSession': (...a: unknown[]) => startSession(...a),
  'projects.home': vi.fn().mockResolvedValue({ ok: true, home: '/home/me', error: null }),
  'shell.input': (...a: unknown[]) => shellInput(...a),
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
const { useShellsStore } = await import('../../src/renderer/stores/shells');

const CHOICE: LaunchChoice = {
  kind: 'claude',
  dir: '~/git/x',
  skipPermissions: true,
  profile: null,
};

/** A session row of the shape `helper.sessionsList` returns. */
function row(name: string, created = 1): unknown {
  return {
    name,
    created,
    activity: created,
    attached: false,
    path: '/home/me/git/x',
    agentKind: null,
  };
}

/** What the host says when it created [name]. */
function started(name: string, reused = false): unknown {
  return {
    ok: true,
    sessionName: name,
    folder: '/home/me/git/x',
    reused,
    via: 'helper',
    error: null,
    code: null,
  };
}

/**
 * The dialog, reduced to "confirm a shell" and "confirm an agent".
 *
 * `v-if="launching"` in the view means these buttons exist only once the `+`
 * menu's "New session…" has been clicked, which is exactly the gate the real
 * dialog sits behind.
 */
const LaunchStub = {
  emits: ['confirm', 'close'],
  setup: () => ({ choice: CHOICE }),
  template:
    '<div class="stub-launch">' +
    '<button class="confirm-shell" @click="$emit(\'confirm\', null)">shell</button>' +
    '<button class="confirm-agent" @click="$emit(\'confirm\', choice)">agent</button>' +
    '</div>',
};

const stubs = {
  TerminalView: { template: '<div class="stub-terminal" />' },
  PromptComposer: { template: '<div class="stub-composer" />' },
  FilesView: { template: '<div class="stub-files" />' },
  OverlayPanel: { template: '<div><slot /></div>' },
  PopupMenu: { template: '<div><slot /></div>' },
  LaunchSessionDialog: LaunchStub,
};

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Mount the workspace on a folder that already holds one session, `git-x`. */
async function openWorkspace(): Promise<VueWrapper> {
  const wrapper = mount(FolderWorkspaceView, { global: { stubs } });
  await flush();
  return wrapper;
}

/** `+` -> "New session…" -> the stub's [what] button. */
async function createVia(wrapper: VueWrapper, what: 'shell' | 'agent'): Promise<void> {
  await wrapper.find('button.add').trigger('click');
  await flush(2);
  const item = wrapper.findAll('button').find((b) => b.text().trim() === 'New session…');
  if (!item) throw new Error(`no "New session…" item in: ${wrapper.text()}`);
  await item.trigger('click');
  await flush(2);
  await wrapper.find(`button.confirm-${what}`).trigger('click');
  await flush(8);
}

/** The visible tab labels, in bar order. */
function tabLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('nav.tabs button').map((b) => b.text().trim());
}

/** The error line under the tab strip, or null when there is none. */
function barError(wrapper: VueWrapper): string | null {
  const el = wrapper.find('.bar-error');
  return el.exists() ? el.text() : null;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  startSession.mockReset();
  sessionsList.mockReset();
  shellInput.mockReset();
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
  useSessionsStore().sessions = [row('git-x')] as never;
});

describe('the folder workspace + menu creates a session', () => {
  it('opens a tab for a genuinely new session', async () => {
    sessionsList.mockResolvedValue([row('git-x'), row('git-x-2', 2)]);
    startSession.mockResolvedValue(started('git-x-2'));

    const wrapper = await openWorkspace();
    expect(tabLabels(wrapper)).toEqual(['Terminal']);

    await createVia(wrapper, 'shell');

    expect(startSession).toHaveBeenCalledWith('conn-1', {
      folder: '~/git/x',
      namePolicy: 'unique',
    });
    expect(tabLabels(wrapper)).toEqual(['Terminal', 'Terminal 2']);
    expect(wrapper.find('nav.tabs button.active').text().trim()).toBe('Terminal 2');
    expect(barError(wrapper)).toBeNull();
  });

  it('launches the agent in the NEW session, not in the one that was in front', async () => {
    sessionsList.mockResolvedValue([row('git-x'), row('git-x-2', 2)]);
    startSession.mockResolvedValue(started('git-x-2'));
    const shells = useShellsStore();
    // The session the user is looking at already has a live PTY. This is the
    // registration the bug wrote into.
    shells.register('git-x', 'shell-1');

    const wrapper = await openWorkspace();
    await createVia(wrapper, 'agent');

    // Nothing is typed until the NEW pane comes up: the launch is waiting on a
    // shell that does not exist yet.
    expect(shellInput).not.toHaveBeenCalled();

    // The new tab's TerminalView joins and publishes its shell.
    shells.register('git-x-2', 'shell-2');
    await flush(4);

    expect(shellInput).toHaveBeenCalledTimes(1);
    expect(shellInput).toHaveBeenCalledWith(
      'shell-2',
      "pocketshell agent claude --dir $HOME/'git/x'\r",
    );
  });

  /**
   * The reported bug, from the outside. The host answers with the name of the
   * session that is already open — which is what a socket-blind free-name walk
   * produces — and the only acceptable outcome is a sentence.
   */
  it('refuses, out loud, when the host answers with a session already on the bar', async () => {
    sessionsList.mockResolvedValue([row('git-x')]);
    startSession.mockResolvedValue(started('git-x'));
    const shells = useShellsStore();
    shells.register('git-x', 'shell-1');

    const wrapper = await openWorkspace();
    await createVia(wrapper, 'agent');
    await flush(4);

    // The whole point: not a byte into the terminal the user was working in.
    expect(shellInput).not.toHaveBeenCalled();
    expect(barError(wrapper)).toContain('git-x');
    expect(barError(wrapper)).toContain('already open');
    expect(tabLabels(wrapper)).toEqual(['Terminal']);
  });

  it('says so when the host answers `reused`, even under a fresh name', async () => {
    sessionsList.mockResolvedValue([row('git-x'), row('git-y', 2)]);
    startSession.mockResolvedValue(started('git-y', true));

    const wrapper = await openWorkspace();
    await createVia(wrapper, 'shell');

    expect(barError(wrapper)).toContain('git-y');
  });

  it('shows the host’s own refusal rather than closing on nothing', async () => {
    startSession.mockResolvedValue({
      ok: false,
      sessionName: null,
      folder: '/home/me/git/x',
      reused: false,
      via: null,
      error: 'Could not ask the host for a free session name, so nothing was created.',
      code: 'name-unavailable',
    });

    const wrapper = await openWorkspace();
    await createVia(wrapper, 'shell');

    expect(barError(wrapper)).toContain('free session name');
    expect(shellInput).not.toHaveBeenCalled();
  });

  it('says so when the created session does not land in this folder', async () => {
    // The create succeeded on the host, but the refreshed list files it
    // elsewhere — so there is no tab here and no pane for a launch to wait on.
    sessionsList.mockResolvedValue([row('git-x')]);
    startSession.mockResolvedValue(started('git-elsewhere'));

    const wrapper = await openWorkspace();
    await createVia(wrapper, 'agent');
    await flush(4);

    expect(shellInput).not.toHaveBeenCalled();
    expect(barError(wrapper)).toContain('git-elsewhere');
    expect(tabLabels(wrapper)).toEqual(['Terminal']);
  });
});
