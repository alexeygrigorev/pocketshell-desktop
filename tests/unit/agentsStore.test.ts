import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The agents store used to be almost entirely the Conversation tab's state,
 * and this file used to test that: `loadForSession`, the transcript `source`,
 * `fail`, and the stale-reply guard. All of it went with the feature
 * (docs/WORKSPACE.md §9).
 *
 * What is left is the usage half, and it is tested here rather than left
 * uncovered because the removal changed it: `loading` used to be written ONLY
 * by the conversation loader while being READ by the usage refresh button in
 * UsageView.vue and HostWorkspaceView.vue. Deleting the writer without giving
 * `loadUsage` ownership would have left a spinner that never spins, with a
 * green test suite. That is exactly the failure a deletion of this size can
 * hide, so it gets an assertion.
 */

const usage = vi.fn();

vi.mock('../../src/renderer/ipc', () => ({
  api: { helper: { usage: (connectionId: string): unknown => usage(connectionId) } },
}));

import { useAgentsStore } from '../../src/renderer/stores/agents';

describe('agents store (usage)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    usage.mockReset();
  });

  it('loads the usage rows', async () => {
    usage.mockResolvedValue([{ provider: 'codex', status: 'ok' }]);
    const store = useAgentsStore();
    expect(store.usage).toEqual([]);
    await store.loadUsage('conn-1');
    expect(usage).toHaveBeenCalledWith('conn-1');
    expect(store.usage).toHaveLength(1);
  });

  it('raises `loading` while the fetch is in flight and lowers it after', async () => {
    let release: (rows: unknown[]) => void = () => {};
    usage.mockReturnValue(
      new Promise<unknown[]>((resolve) => {
        release = resolve;
      }),
    );
    const store = useAgentsStore();
    const inFlight = store.loadUsage('conn-1');
    expect(store.loading).toBe(true);
    release([]);
    await inFlight;
    expect(store.loading).toBe(false);
  });

  it('lowers `loading` even when the fetch rejects', async () => {
    usage.mockRejectedValue(new Error('no helper'));
    const store = useAgentsStore();
    await expect(useAgentsStore().loadUsage('conn-1')).rejects.toThrow('no helper');
    expect(store.loading).toBe(false);
  });
});
