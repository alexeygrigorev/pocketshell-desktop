import { describe, expect, it } from 'vitest';
import {
  ConversationAttributionService,
  AgentType,
  cwdFromSessionContent,
  cwdFromSessionPath,
  detectAgentTypeFromCommand,
  enrichActivePaneConversationContext,
  enrichConversationSessions,
  enrichSessionsFromAgentDetections,
  parseProcessEvidenceRows,
  type ActivePaneConversationContext,
  type AttributableConversationSession,
} from '../../../src/agents';
import type { ExecResult, SshConnection } from '../../../src/ssh/connection/ssh-client';

function pane(overrides: Partial<ActivePaneConversationContext> = {}): ActivePaneConversationContext {
  return {
    id: '%1',
    sessionId: '$1',
    windowId: '@1',
    cwd: '/workspace/app',
    tty: '/dev/pts/4',
    process: {
      currentCommand: 'claude',
      pid: 123,
    },
    ...overrides,
  };
}

function session(overrides: Partial<AttributableConversationSession> = {}): AttributableConversationSession {
  return {
    id: 'session-1',
    agentType: AgentType.Claude,
    path: '/home/alice/.claude/projects/-workspace-app/session-1.jsonl',
    size: 100,
    modifiedAt: 1_000,
    cwd: '/workspace/app',
    ...overrides,
  };
}

function realSession(overrides: Partial<AttributableConversationSession> = {}): AttributableConversationSession {
  return {
    id: 'pocketshell-claude',
    agentType: AgentType.Claude,
    path: '/tmp/pocketshell/sessions/claude/pocketshell-claude.jsonl',
    size: 100,
    modifiedAt: 1_000,
    ...overrides,
  };
}

function mockConnection(handler: (command: string) => ExecResult | Promise<ExecResult>): SshConnection {
  return {
    connected: true,
    async exec(command: string): Promise<ExecResult> {
      return handler(command);
    },
    async shell() {
      throw new Error('not implemented');
    },
    async sftp() {
      throw new Error('not implemented');
    },
    disconnect() {},
  };
}

const DETECTIONS = [
  'engine|session|pane|pid|cwd|detected_at',
  'claude|pocketshell-claude|0|12345|/home/testuser/git/pocketshell|2026-01-01T00:00:00Z',
  'codex|pocketshell-codex|1|12346|/home/testuser/git/pocketshell|2026-01-01T00:01:00Z',
  'opencode|pocketshell-rows|2|12347|/home/testuser/git/test-project|2026-01-01T00:02:00Z',
].join('\n');

describe('ConversationAttributionService', () => {
  it('returns a clear match by active pane cwd and command', () => {
    const service = new ConversationAttributionService();
    const result = service.attribute(pane(), [session()]);

    expect(result.kind).toBe('match');
    expect(result.session?.id).toBe('session-1');
    expect(result.agentType).toBe('claude');
    expect(result.shouldShowHint).toBe(true);
  });

  it('suppresses ambiguous matches', () => {
    const service = new ConversationAttributionService();
    const result = service.attribute(pane(), [
      session({ id: 'a', path: '/logs/a.jsonl' }),
      session({ id: 'b', path: '/logs/b.jsonl' }),
    ]);

    expect(result.kind).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
    expect(result.shouldShowHint).toBe(false);
    expect(result.session).toBeUndefined();
  });

  it('does not show a hint when attribution is ambiguous', () => {
    const service = new ConversationAttributionService();
    const result = service.attribute(pane(), [
      session({ id: 'a' }),
      session({ id: 'b' }),
    ]);

    expect(result.kind).not.toBe('match');
    expect(result.shouldShowHint).toBe(false);
  });

  it('tracks dismissal per tmux session and pane', () => {
    const service = new ConversationAttributionService();
    const firstPane = pane({ id: '%1', sessionId: '$1' });
    const secondPane = pane({ id: '%2', sessionId: '$1' });

    expect(service.attribute(firstPane, [session()]).shouldShowHint).toBe(true);
    service.dismiss(firstPane);

    const dismissed = service.attribute(firstPane, [session()]);
    expect(dismissed.kind).toBe('match');
    expect(dismissed.dismissed).toBe(true);
    expect(dismissed.shouldShowHint).toBe(false);

    const otherPane = service.attribute(secondPane, [session()]);
    expect(otherPane.dismissed).toBe(false);
    expect(otherPane.shouldShowHint).toBe(true);
  });

  it('uses cached results for unchanged pane and session evidence', () => {
    const service = new ConversationAttributionService();
    const activePane = pane();
    const sessions = [session()];

    expect(service.attribute(activePane, sessions).fromCache).toBe(false);
    const cached = service.attribute(activePane, sessions);
    expect(cached.kind).toBe('match');
    expect(cached.fromCache).toBe(true);
  });

  it('re-evaluates when enriched commandLine and pids change', () => {
    const service = new ConversationAttributionService();
    const sessions = [
      realSession({
        id: 'pocketshell-codex',
        agentType: AgentType.Codex,
        path: '/tmp/pocketshell/sessions/codex/pocketshell-codex.jsonl',
        cwd: '/home/testuser/git/pocketshell',
        pid: 12346,
      }),
    ];
    const basePane = pane({
      cwd: '/home/testuser/git/pocketshell',
      process: { currentCommand: 'pocketshell', pid: 100 },
    });

    const first = service.attribute(basePane, sessions);
    expect(first.kind).toBe('no-match');
    expect(first.fromCache).toBe(false);

    const enriched = service.attribute({
      ...basePane,
      process: {
        currentCommand: 'pocketshell',
        commandLine: 'pocketshell agent codex --dir /home/testuser/git/pocketshell',
        argv: ['pocketshell', 'agent', 'codex', '--dir', '/home/testuser/git/pocketshell'],
        pid: 100,
        pids: [12346, 100, 12346],
      },
    }, sessions);

    expect(enriched.fromCache).toBe(false);
    expect(enriched.kind).toBe('match');
    expect(enriched.session?.id).toBe('pocketshell-codex');
  });

  it('matches Codex sessions by cwd and command', () => {
    const service = new ConversationAttributionService();
    const result = service.attribute(
      pane({ process: { currentCommand: 'codex', pid: 222 } }),
      [session({ id: 'codex-1', agentType: AgentType.Codex, path: '/home/alice/.codex/sessions/2026/05/22/codex-1.jsonl' })],
    );

    expect(result.kind).toBe('match');
    expect(result.agentType).toBe('codex');
    expect(result.session?.id).toBe('codex-1');
  });

  it('matches OpenCode sessions by cwd and command', () => {
    const service = new ConversationAttributionService();
    const result = service.attribute(
      pane({ process: { currentCommand: 'opencode', pid: 333 } }),
      [session({ id: 'opencode-1', agentType: AgentType.OpenCode, path: '/home/alice/.local/share/opencode/opencode-1.jsonl' })],
    );

    expect(result.kind).toBe('match');
    expect(result.agentType).toBe('opencode');
    expect(result.session?.id).toBe('opencode-1');
  });

  it('does not match real SessionInfo records until cwd is enriched', () => {
    const service = new ConversationAttributionService();
    const result = service.attribute(
      pane({
        cwd: '/home/testuser/git/pocketshell',
        process: { currentCommand: 'claude', pid: 12345 },
      }),
      [realSession()],
    );

    expect(result.kind).toBe('no-match');
    expect(result.shouldShowHint).toBe(false);
  });

  it('matches real SessionInfo records after agent detection metadata enrichment', () => {
    const service = new ConversationAttributionService();
    const sessions = enrichSessionsFromAgentDetections([
      realSession(),
      realSession({
        id: 'pocketshell-codex',
        agentType: AgentType.Codex,
        path: '/tmp/pocketshell/sessions/codex/pocketshell-codex.jsonl',
      }),
      realSession({
        id: 'pocketshell-rows',
        agentType: AgentType.OpenCode,
        path: '/tmp/pocketshell/sessions/opencode/pocketshell-rows.jsonl',
      }),
    ], DETECTIONS);

    expect(service.attribute(
      pane({
        cwd: '/home/testuser/git/pocketshell',
        process: { currentCommand: 'claude', pid: 12345 },
      }),
      sessions,
    ).session?.id).toBe('pocketshell-claude');
    expect(service.attribute(
      pane({
        cwd: '/home/testuser/git/pocketshell',
        process: { currentCommand: 'codex', pid: 12346 },
      }),
      sessions,
    ).session?.id).toBe('pocketshell-codex');
    expect(service.attribute(
      pane({
        cwd: '/home/testuser/git/test-project',
        process: { currentCommand: 'opencode', pid: 12347 },
      }),
      sessions,
    ).session?.id).toBe('pocketshell-rows');
  });

  it('enriches real SessionInfo records from SSH metadata before matching', async () => {
    const conn = mockConnection((command) => {
      if (command.includes('agent-detections')) {
        return { stdout: DETECTIONS, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const sessions = await enrichConversationSessions(conn, [
      realSession({
        id: 'pocketshell-codex',
        agentType: AgentType.Codex,
        path: '/tmp/pocketshell/sessions/codex/pocketshell-codex.jsonl',
      }),
    ]);

    const result = new ConversationAttributionService().attribute(
      pane({
        cwd: '/home/testuser/git/pocketshell',
        process: { currentCommand: 'codex', pid: 12346 },
      }),
      sessions,
    );

    expect(result.kind).toBe('match');
    expect(result.session?.cwd).toBe('/home/testuser/git/pocketshell');
  });

  it('falls back to cwd fields in session content when detection metadata is absent', async () => {
    const conn = mockConnection((command) => {
      if (command.includes('agent-detections')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command.includes('sed -n')) {
        return {
          stdout: '{"type":"session","cwd":"/home/testuser/git/pocketshell"}\n',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 1 };
    });

    const sessions = await enrichConversationSessions(conn, [realSession()]);

    expect(sessions[0].cwd).toBe('/home/testuser/git/pocketshell');
  });

  it('caps session content fallback reads and concurrency', async () => {
    let fallbackReads = 0;
    let activeFallbackReads = 0;
    let maxActiveFallbackReads = 0;
    const conn = mockConnection(async (command) => {
      if (command.includes('agent-detections')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command.includes('sed -n')) {
        fallbackReads += 1;
        activeFallbackReads += 1;
        maxActiveFallbackReads = Math.max(maxActiveFallbackReads, activeFallbackReads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeFallbackReads -= 1;
        return {
          stdout: '{"cwd":"/bounded"}\n',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 1 };
    });
    const sessions = Array.from({ length: 8 }, (_, index) => realSession({
      id: `session-${index}`,
      path: `/tmp/pocketshell/sessions/claude/session-${index}.jsonl`,
    }));

    const enriched = await enrichConversationSessions(conn, sessions, {
      maxContentFallbackReads: 3,
      contentFallbackConcurrency: 2,
    });

    expect(fallbackReads).toBe(3);
    expect(maxActiveFallbackReads).toBeLessThanOrEqual(2);
    expect(enriched.slice(0, 3).every((session) => session.cwd === '/bounded')).toBe(true);
    expect(enriched.slice(3).every((session) => session.cwd === undefined)).toBe(true);
  });

  it('requires process evidence for the matching agent type', () => {
    const service = new ConversationAttributionService();
    const result = service.attribute(
      pane({ process: { currentCommand: 'vim', pid: 123 } }),
      [session()],
    );

    expect(result.kind).toBe('no-match');
    expect(result.shouldShowHint).toBe(false);
  });

  it('uses pane-scoped pid and tty evidence when session metadata provides it', () => {
    const service = new ConversationAttributionService();
    const result = service.attribute(pane(), [
      session({ id: 'wrong-process', pid: 999, tty: '/dev/pts/4' }),
      session({ id: 'right-process', pid: 123, tty: '/dev/pts/4' }),
    ]);

    expect(result.kind).toBe('match');
    expect(result.session?.id).toBe('right-process');
  });

  it('uses wrapped pocketshell argv from pane process evidence', async () => {
    const conn = mockConnection((command) => {
      if (command.includes('ps -o pid=')) {
        return {
          stdout: [
            '100|1|pts/4|pocketshell agent codex --dir /home/testuser/git/pocketshell',
            '12346|100|pts/4|codex --resume pocketshell-codex',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const enrichedPane = await enrichActivePaneConversationContext(conn, pane({
      cwd: '/home/testuser/git/pocketshell',
      tty: '/dev/pts/4',
      process: { currentCommand: 'pocketshell', pid: 100 },
    }));
    const sessions = enrichSessionsFromAgentDetections([
      realSession({
        id: 'pocketshell-codex',
        agentType: AgentType.Codex,
        path: '/tmp/pocketshell/sessions/codex/pocketshell-codex.jsonl',
      }),
    ], DETECTIONS);

    const result = new ConversationAttributionService().attribute(enrichedPane, sessions);

    expect(enrichedPane?.process?.commandLine).toContain('pocketshell agent codex');
    expect(enrichedPane?.process?.pids).toContain(12346);
    expect(result.kind).toBe('match');
    expect(result.session?.id).toBe('pocketshell-codex');
  });

  it('can infer Claude cwd from existing log path convention', () => {
    expect(cwdFromSessionPath(
      '/home/alice/.claude/projects/-workspace-app/session-1.jsonl',
      AgentType.Claude,
    )).toBe('/workspace/app');

    const service = new ConversationAttributionService();
    const result = service.attribute(
      pane(),
      [session({ cwd: undefined, path: '/home/alice/.claude/projects/-workspace-app/session-1.jsonl' })],
    );
    expect(result.kind).toBe('match');
  });
});

describe('detectAgentTypeFromCommand', () => {
  it('detects direct and pocketshell-wrapped agent commands', () => {
    expect(detectAgentTypeFromCommand('/usr/local/bin/claude')).toBe('claude');
    expect(detectAgentTypeFromCommand('codex --approval-mode never')).toBe('codex');
    expect(detectAgentTypeFromCommand('pocketshell agent opencode --dir /workspace/app')).toBe('opencode');
  });
});

describe('process and session enrichment helpers', () => {
  it('parses process evidence rows with argv', () => {
    const rows = parseProcessEvidenceRows('100|1|pts/4|pocketshell agent claude --dir /repo\n');

    expect(rows).toEqual([{
      pid: 100,
      ppid: 1,
      tty: 'pts/4',
      commandLine: 'pocketshell agent claude --dir /repo',
    }]);
  });

  it('finds cwd fields in session content', () => {
    expect(cwdFromSessionContent('{"metadata":{"cwd":"/repo"}}\n')).toBe('/repo');
  });
});
