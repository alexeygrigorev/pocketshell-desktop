// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';

/**
 * The launch dialog, tested for the two properties that the bug it replaces
 * violated:
 *
 *   1. **It builds a command the helper accepts.** The old `+` menu typed a
 *      bare `pocketshell agent claude`, which exits 2 on `--dir`. The flag
 *      spellings themselves are pinned against the captured `--help` in
 *      agentLaunch.test.ts; what is checked HERE is that the controls reach
 *      the builder — that ticking the toggle actually changes the line.
 *   2. **It creates nothing.** The dialog emits a choice and the caller
 *      creates the session, so cancelling costs nothing and a launch that
 *      cannot work is stopped before anything exists on the host.
 */

const profiles = vi.fn();

// Only `agent.profiles` has behaviour; the rest is here because constructing
// the connection/projects stores subscribes to them.
vi.mock('../../src/renderer/ipc', () => ({
  api: {
    helper: { usage: vi.fn().mockResolvedValue([]) },
    agent: { profiles: (connectionId: string): unknown => profiles(connectionId) },
    ssh: { onState: vi.fn(), listConfigHosts: vi.fn().mockResolvedValue([]) },
    projects: { onCloneProgress: vi.fn() },
  },
}));

const LaunchSessionDialog = (await import('../../src/renderer/components/LaunchSessionDialog.vue'))
  .default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useSettingsStore } = await import('../../src/renderer/stores/settings');

/** The host's real 0.4.44 shape: a default profile plus a named sibling. */
const HOST_PROFILES = [
  { name: 'Claude', engine: 'claude', config_dir: null, default: true },
  { name: 'Claude (Z.AI)', engine: 'claude', config_dir: '/home/t/.zlaude', default: false },
  { name: 'Codex', engine: 'codex', config_dir: null, default: true },
];

async function open(folderPath: string | null = '~/git/my app'): Promise<VueWrapper> {
  const wrapper = mount(LaunchSessionDialog, {
    props: { folderPath, folderLabel: 'my app' },
    global: { stubs: { OverlayPanel: { template: '<div><slot /></div>' } } },
  });
  await flush();
  return wrapper;
}

/** Let the mounted profile fetch settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Click the button whose visible text is exactly [label]. */
async function click(wrapper: VueWrapper, label: string): Promise<void> {
  const button = wrapper.findAll('button').find((b) => b.text().trim() === label);
  if (!button) throw new Error(`no button labelled "${label}" in: ${wrapper.text()}`);
  await button.trigger('click');
}

/** The single emitted choice, or null for a shell. */
function confirmed(wrapper: VueWrapper): unknown {
  const events = wrapper.emitted('confirm');
  expect(events, 'nothing was confirmed').toBeTruthy();
  return (events as unknown[][])[0]![0];
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  profiles.mockReset().mockResolvedValue(HOST_PROFILES);
  useConnectionStore().connectionId = 'conn-1';
});

describe('what it emits', () => {
  it('defaults to an agent launch with the helper’s own defaults', async () => {
    const wrapper = await open();
    await click(wrapper, 'Create session');
    expect(confirmed(wrapper)).toEqual({
      kind: 'claude',
      dir: '~/git/my app',
      skipPermissions: true,
      // The host's default profile is pre-selected but passed as null: naming
      // it is the same launch as omitting it.
      profile: null,
    });
  });

  it('carries a turned-off permission toggle through to the choice', async () => {
    const wrapper = await open();
    await click(wrapper, 'Skip permission prompts');
    await click(wrapper, 'Create session');
    expect(confirmed(wrapper)).toMatchObject({ skipPermissions: false });
  });

  it('carries a non-default profile through by name', async () => {
    const wrapper = await open();
    await click(wrapper, 'Claude (Z.AI)');
    await click(wrapper, 'Create session');
    expect(confirmed(wrapper)).toMatchObject({ profile: 'Claude (Z.AI)' });
  });

  it('emits null for a plain shell, which starts no agent', async () => {
    const wrapper = await open();
    await click(wrapper, 'Shell');
    await click(wrapper, 'Create session');
    expect(confirmed(wrapper)).toBeNull();
  });

  it('switches engine without carrying a claude profile into codex', async () => {
    const wrapper = await open();
    await click(wrapper, 'Claude (Z.AI)');
    await click(wrapper, 'Codex');
    await click(wrapper, 'Create session');
    // `Codex` is the codex default, so it resolves to no flag — never the
    // claude profile the host would reject.
    expect(confirmed(wrapper)).toEqual({
      kind: 'codex',
      dir: '~/git/my app',
      skipPermissions: true,
      profile: null,
    });
  });
});

describe('what the helper cannot do', () => {
  it('offers no Grok, which has no `pocketshell agent` subcommand', async () => {
    const wrapper = await open();
    expect(wrapper.text()).not.toMatch(/Grok/i);
  });

  it('hides the permission toggle for opencode, where the flag is a no-op', async () => {
    const wrapper = await open();
    expect(wrapper.text()).toContain('Skip permission prompts');
    await click(wrapper, 'OpenCode');
    expect(wrapper.text()).not.toContain('Skip permission prompts');
  });

  it('offers no profile picker for opencode, which has no config dir', async () => {
    const wrapper = await open();
    expect(wrapper.text()).toContain('Claude (Z.AI)');
    await click(wrapper, 'OpenCode');
    expect(wrapper.text()).not.toContain('Claude (Z.AI)');
  });
});

describe('failing before anything is created', () => {
  it('blocks confirm for a folder with no host directory', async () => {
    const wrapper = await open(null);
    const button = wrapper.findAll('button').find((b) => b.text().trim() === 'Create session');
    expect(button!.attributes('disabled')).toBeDefined();
    await button!.trigger('click');
    expect(wrapper.emitted('confirm')).toBeUndefined();
    expect(wrapper.text()).toMatch(/no known directory/);
  });

  it('confirms nothing when cancelled', async () => {
    const wrapper = await open();
    await click(wrapper, 'Cancel');
    expect(wrapper.emitted('confirm')).toBeUndefined();
    expect(wrapper.emitted('close')).toBeTruthy();
  });
});

describe('remembered defaults', () => {
  it('writes the answers only on confirm', async () => {
    const wrapper = await open();
    await click(wrapper, 'Codex');
    await click(wrapper, 'Skip permission prompts');
    // Poked at, then abandoned: the defaults must be untouched.
    await click(wrapper, 'Cancel');
    expect(useSettingsStore().agentLaunchDefaults).toEqual({
      kind: 'claude',
      skipPermissions: true,
      profiles: {},
    });
  });

  it('re-opens on the last confirmed choice', async () => {
    const first = await open();
    await click(first, 'Codex');
    await click(first, 'Skip permission prompts');
    await click(first, 'Create session');
    expect(useSettingsStore().agentLaunchDefaults).toMatchObject({
      kind: 'codex',
      skipPermissions: false,
    });

    const second = await open();
    await click(second, 'Create session');
    expect(confirmed(second)).toMatchObject({ kind: 'codex', skipPermissions: false });
  });

  it('remembers a profile per engine', async () => {
    const first = await open();
    await click(first, 'Claude (Z.AI)');
    await click(first, 'Create session');

    const second = await open();
    await click(second, 'Create session');
    expect(confirmed(second)).toMatchObject({ kind: 'claude', profile: 'Claude (Z.AI)' });
  });

  it('ignores a remembered profile the host stopped listing', async () => {
    const first = await open();
    await click(first, 'Claude (Z.AI)');
    await click(first, 'Create session');

    // The host drops the sibling config dir; only the default remains.
    profiles.mockResolvedValue([HOST_PROFILES[0]]);
    const second = await open();
    await click(second, 'Create session');
    expect(confirmed(second)).toMatchObject({ profile: null });
  });
});

describe('a host that has no profiles to offer', () => {
  it('says so, and still launches on the engine default', async () => {
    profiles.mockResolvedValue([]);
    const wrapper = await open();
    expect(wrapper.text()).toMatch(/no Claude Code profiles configured/);
    await click(wrapper, 'Create session');
    expect(confirmed(wrapper)).toMatchObject({ profile: null });
  });

  it('distinguishes a FAILED fetch from an empty one, and still launches', async () => {
    profiles.mockRejectedValue(new Error('no helper here'));
    const wrapper = await open();
    expect(wrapper.text()).toMatch(/Could not list/);
    await click(wrapper, 'Create session');
    expect(confirmed(wrapper)).toMatchObject({ kind: 'claude', profile: null });
  });
});
