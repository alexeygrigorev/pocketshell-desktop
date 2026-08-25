import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { SessionSummary } from '../../src/shared/types';
import type { SessionConversation } from '../../src/main/helper/PocketshellClient';

/**
 * The agents store's conversation half, driven through the store rather than a
 * rendered tree (the same reasoning as composerStore.test.ts: the rules being
 * pinned are state rules).
 *
 * What matters here is what the Conversation tab promises: the conversation
 * follows the SELECTED SESSION, and the panel is never left empty and silent.
 */

const sessionLog = vi.fn<(id: string, opts: unknown) => Promise<SessionConversation>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    agent: {
      sessionLog: (id: string, opts: unknown) => sessionLog(id, opts),
    },
  },
}));

const { useAgentsStore } = await import('../../src/renderer/stores/agents');

const CONN = 'conn-1' as never;

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    name: 'main',
    created: 0,
    activity: 0,
    attached: true,
    path: '/workspace/demo',
    agentKind: 'claude',
    ...over,
  };
}

function ok(lines: string[]): SessionConversation {
  return {
    ok: true,
    engine: 'claude',
    transcriptId: 'demo-claude',
    path: '/home/t/.claude/projects/-workspace-demo/demo-claude.jsonl',
    lines,
    cwdVerified: true,
    error: null,
  };
}

const USER_LINE = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });

type Store = ReturnType<typeof useAgentsStore>;
let agents: Store;

beforeEach(() => {
  setActivePinia(createPinia());
  agents = useAgentsStore();
  sessionLog.mockReset();
});

describe('loadForSession', () => {
  it('asks for the session by name, cwd and recorded engine — no user choice', () => {
    sessionLog.mockResolvedValueOnce(ok([USER_LINE]));
    void agents.loadForSession(CONN, summary());
    expect(sessionLog).toHaveBeenCalledWith(CONN, {
      session: 'main',
      engine: 'claude',
      cwd: '/workspace/demo',
    });
  });

  it('sends a null engine for a session tmux never tagged', () => {
    // `shell` is a recorded kind, but the user can still have started an agent
    // by hand inside it — null means "prove it from the path", not "give up".
    sessionLog.mockResolvedValueOnce(ok([USER_LINE]));
    void agents.loadForSession(CONN, summary({ agentKind: 'shell' }));
    expect(sessionLog).toHaveBeenCalledWith(
      CONN,
      expect.objectContaining({ engine: null }),
    );
  });

  it('renders the returned lines and records where they came from', async () => {
    sessionLog.mockResolvedValueOnce(ok([USER_LINE]));
    await agents.loadForSession(CONN, summary());
    expect(agents.messages).toHaveLength(1);
    expect(agents.messages[0]!.role).toBe('user');
    expect(agents.source?.transcriptId).toBe('demo-claude');
    expect(agents.error).toBeNull();
  });

  it('surfaces a resolution failure instead of showing an empty panel', async () => {
    sessionLog.mockResolvedValueOnce({
      ok: false,
      engine: null,
      transcriptId: null,
      path: null,
      lines: [],
      cwdVerified: false,
      error: 'No claude conversation found for session "main".',
    });
    await agents.loadForSession(CONN, summary());
    expect(agents.messages).toEqual([]);
    expect(agents.error).toContain('No claude conversation');
    expect(agents.source).toBeNull();
  });

  it('complains when a transcript loads but parses to no messages', async () => {
    // Lines came back, so this is not "no conversation" — it is a shape we
    // failed to read, and the difference has to reach the user.
    sessionLog.mockResolvedValueOnce(ok(['not json at all']));
    await agents.loadForSession(CONN, summary());
    expect(agents.messages).toEqual([]);
    expect(agents.error).toContain('parsed as claude conversation messages');
  });

  it('reports a thrown IPC error rather than swallowing it', async () => {
    sessionLog.mockRejectedValueOnce(new Error('connection closed'));
    await agents.loadForSession(CONN, summary());
    expect(agents.error).toBe('connection closed');
    expect(agents.loading).toBe(false);
  });

  it('reloads for the newly selected session', async () => {
    sessionLog.mockResolvedValueOnce(ok([USER_LINE]));
    await agents.loadForSession(CONN, summary());
    sessionLog.mockResolvedValueOnce(ok([]));
    await agents.loadForSession(CONN, summary({ name: 'build', path: '/workspace/build' }));
    expect(agents.session).toBe('build');
    expect(sessionLog).toHaveBeenLastCalledWith(
      CONN,
      expect.objectContaining({ session: 'build', cwd: '/workspace/build' }),
    );
  });

  it('drops a reply that lost the race to a newer session switch', async () => {
    // Switching sessions fast must not paint the old session's transcript over
    // the new one's — the tab stays mounted across a switch, so both loads are
    // in flight against the same store.
    let releaseSlow: (v: SessionConversation) => void = () => {};
    sessionLog.mockImplementationOnce(
      () => new Promise<SessionConversation>((resolve) => (releaseSlow = resolve)),
    );
    const slow = agents.loadForSession(CONN, summary());

    sessionLog.mockResolvedValueOnce(ok([]));
    await agents.loadForSession(CONN, summary({ name: 'build' }));

    releaseSlow(ok([USER_LINE]));
    await slow;

    expect(agents.session).toBe('build');
    expect(agents.messages).toEqual([]);
  });
});

describe('fail', () => {
  it('lets the view report a failure it detected itself', async () => {
    sessionLog.mockResolvedValueOnce(ok([USER_LINE]));
    await agents.loadForSession(CONN, summary());
    agents.fail('Session "main" is not in this host\'s session list.');
    expect(agents.messages).toEqual([]);
    expect(agents.source).toBeNull();
    expect(agents.loading).toBe(false);
    expect(agents.error).toContain('not in this host');
  });
});
