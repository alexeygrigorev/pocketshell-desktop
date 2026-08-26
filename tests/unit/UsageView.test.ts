// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';

/**
 * The usage panel's four states, because until this file existed it only had
 * two — table or empty — and the empty one told a lie twice over.
 *
 * The panel rendered `usage.length ? table : "no usage data — is pocketshell
 * usage available on this host?"`. During the INITIAL fetch `usage` is empty
 * by definition, so the accusation flashed while the answer was still in
 * flight; and when the fetch FAILED the store rethrew, so the panel kept
 * whatever it had with no word about why. What is pinned here is the full
 * matrix: loading is a quiet holding line, an answered-empty is the (now
 * `<code>`-formatted) empty state, a failure is the error line — and a failure
 * AFTER data leaves the stale table on screen with the error beside it,
 * because a table a few minutes old with a reason attached beats an empty one.
 */

const usage = vi.fn();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    helper: { usage: (connectionId: string): unknown => usage(connectionId) },
    // The connection store subscribes to transport-state events as it is
    // created, so the mock must carry the listener hook even though no test
    // here exercises it.
    ssh: { onState: vi.fn() },
  },
}));

const UsageView = (await import('../../src/renderer/views/UsageView.vue')).default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useAgentsStore } = await import('../../src/renderer/stores/agents');

/** One well-formed 0.4.44 row — enough for the table to render a provider. */
const ROW = {
  provider: 'claude',
  status: 'ok',
  short_term: { percent_remaining: 62, reset_at: null, window: '5h' },
  long_term: { percent_remaining: 80, reset_at: null, window: 'weekly' },
  error: null,
  details: {},
};

async function flush(wrapper: VueWrapper): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

/** Mount embedded (as OverlayPanel hosts it), pointed at a live connection. */
async function show(): Promise<VueWrapper> {
  useConnectionStore().connectionId = 'conn-1';
  const wrapper = mount(UsageView, { props: { embedded: true } });
  await flush(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  usage.mockReset();
});

describe('UsageView states', () => {
  it('holds a quiet loading line while the first fetch is in flight', async () => {
    // Never resolves within the test: the state under test is "still asking".
    usage.mockReturnValue(new Promise(() => {}));
    const wrapper = await show();

    expect(wrapper.text()).toContain('loading usage');
    // The old behaviour: the empty-state accusation flashed here, while the
    // host had not yet had the chance to answer.
    expect(wrapper.text()).not.toContain('no usage data');
    expect(wrapper.find('.usage-table').exists()).toBe(false);
  });

  it('renders the table once rows arrive', async () => {
    usage.mockResolvedValue([ROW]);
    const wrapper = await show();

    expect(wrapper.find('.usage-table').exists()).toBe(true);
    expect(wrapper.text()).toContain('claude');
    expect(wrapper.text()).not.toContain('no usage data');
    expect(wrapper.find('.error').exists()).toBe(false);
  });

  it('shows the empty state only for an ANSWERED empty, with <code> not backticks', async () => {
    usage.mockResolvedValue([]);
    const wrapper = await show();

    expect(wrapper.text()).toContain('no usage data');
    // The command name is markup, not literal backtick glyphs.
    expect(wrapper.find('.empty code').text()).toBe('pocketshell usage');
    expect(wrapper.text()).not.toContain('`');
  });

  it('shows the failure, not the empty-state accusation, when the fetch rejects', async () => {
    usage.mockRejectedValue(new Error('helper not found on host'));
    const wrapper = await show();

    expect(wrapper.find('.error').text()).toContain('helper not found on host');
    // "is `pocketshell usage` available?" would be the wrong sentence — we
    // never managed to ask.
    expect(wrapper.text()).not.toContain('no usage data');
  });

  it('keeps the stale table on screen when a REFRESH fails, error alongside', async () => {
    usage.mockResolvedValueOnce([ROW]);
    const wrapper = await show();
    expect(wrapper.find('.usage-table').exists()).toBe(true);

    usage.mockRejectedValueOnce(new Error('connection lost'));
    await useAgentsStore().loadUsage('conn-1');
    await flush(wrapper);

    // Both at once: the rows the last good fetch produced, and the reason
    // they may be stale.
    expect(wrapper.find('.usage-table').exists()).toBe(true);
    expect(wrapper.text()).toContain('claude');
    expect(wrapper.find('.error').text()).toContain('connection lost');
  });
});
