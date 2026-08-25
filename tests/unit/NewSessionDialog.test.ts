// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';

/**
 * `NewSessionDialog`'s `startIn` prop — "open the picker AT this folder".
 *
 * It exists for the session panel's per-root `+`: the root is known, the
 * folder under it is not, so the dialog still opens and simply opens one level
 * in. What is tested here is only the seam that prop creates, because it has a
 * failure mode that is silent and expensive.
 *
 * **The browser's cwd lives in the projects STORE, not in this component.** It
 * therefore survives the dialog closing. Without clearing it first, a `startIn`
 * browse that FAILS — a registered root that is not on this host, which the
 * panel renders deliberately (a registered root is a statement of intent) —
 * would leave the picker pointed at whatever folder was browsed last time, with
 * `Start session` live and the preview naming a folder the user never chose.
 * The user would press `+` beside `tmp` and get a session in `~/git/dataops`.
 */

const home = vi.fn<() => Promise<{ ok: boolean; home?: string; error?: string }>>();
const realPath = vi.fn<(id: string, path: string) => Promise<string>>();
const list = vi.fn<(id: string, path: string) => Promise<{ name: string; type: string }[]>>();
const deriveName = vi.fn<() => Promise<string>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    projects: {
      home: () => home(),
      deriveName: () => deriveName(),
      reposList: vi.fn().mockResolvedValue({ repos: [] }),
      onCloneProgress: vi.fn(),
    },
    sftp: {
      realPath: (id: string, path: string) => realPath(id, path),
      list: (id: string, path: string) => list(id, path),
    },
    ssh: { onState: vi.fn(), listConfigHosts: vi.fn().mockResolvedValue([]) },
    helper: { usage: vi.fn().mockResolvedValue([]) },
  },
}));

const NewSessionDialog = (await import('../../src/renderer/components/NewSessionDialog.vue'))
  .default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useProjectsStore } = await import('../../src/renderer/stores/projects');

const HOME = '/home/alexey';

async function open(startIn: string | null): Promise<VueWrapper> {
  useConnectionStore().connectionId = 'conn-1';
  const wrapper = mount(NewSessionDialog, {
    props: { startIn },
    global: { stubs: { OverlayPanel: { template: '<div><slot /></div>' } } },
  });
  await flush(wrapper);
  return wrapper;
}

async function flush(wrapper: VueWrapper): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  home.mockResolvedValue({ ok: true, home: HOME });
  deriveName.mockResolvedValue('git-dataops');
  realPath.mockImplementation(async (_id, path) => path);
  list.mockResolvedValue([{ name: 'dataops', type: 'dir' }]);
});

describe('NewSessionDialog startIn', () => {
  it('lands the browser on the given folder rather than on $HOME', async () => {
    await open(`${HOME}/git`);
    expect(useProjectsStore().cwd).toBe('/home/alexey/git');
    // `$HOME` is still resolved — every displayed path and the name preview are
    // written relative to it — it is just not where the browse lands.
    expect(useProjectsStore().home).toBe(HOME);
  });

  it('keeps landing on $HOME when nothing is given', async () => {
    await open(null);
    expect(useProjectsStore().cwd).toBe(HOME);
  });

  it('leaves NO target when the folder is not on the host', async () => {
    // The stale-cwd trap. A previous open left the browser somewhere real; the
    // root this open asks for does not exist.
    const projects = useProjectsStore();
    projects.cwd = `${HOME}/git/dataops`;
    realPath.mockRejectedValue(new Error('No such file'));

    const wrapper = await open(`${HOME}/tmp`);

    expect(projects.cwd).toBe('');
    expect(projects.browseError).toContain('No such file');
    // Start is dead: with no cwd there is no folder to create a session in, so
    // the failure costs the user a message rather than a session in the wrong
    // place.
    const start = wrapper.findAll('button').find((b) => b.text().includes('Start session'));
    expect(start?.attributes('disabled')).toBeDefined();
  });

  it('does not inherit a folder left over from a previous open', async () => {
    // Same guard, in the case where the browse SUCCEEDS: the cwd that shows is
    // the one asked for, never the one that happened to be there.
    const projects = useProjectsStore();
    projects.cwd = `${HOME}/git/dataops`;
    await open(`${HOME}/tmp`);
    expect(projects.cwd).toBe('/home/alexey/tmp');
  });
});
