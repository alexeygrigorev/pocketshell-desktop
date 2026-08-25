import { describe, expect, it } from 'vitest';
import type { SshService } from '@main/ssh/SshService';
import { PocketshellClient } from '@main/helper/PocketshellClient';

/**
 * `PocketshellClient.sessionConversation` — the whole Conversation-tab path,
 * from "the user has session X selected" to JSONL lines.
 *
 * The behaviour under test is the contract the tab depends on: it is driven by
 * a SESSION, it resolves the transcript id itself, and it never answers
 * "nothing" without a sentence saying why.
 */

const CLAUDE = '/home/testuser/.claude/projects/-workspace-demo/demo-claude.jsonl';
const CODEX = '/home/testuser/.codex/sessions/2026/05/23/demo-codex.jsonl';

const CLAUDE_LINE = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'hello' },
});

/** Minimal SshService double: first matching reply wins, commands recorded. */
function fakeSsh(
  replies: { match: RegExp; stdout?: string; stderr?: string; exitCode?: number }[],
  log: string[] = [],
): SshService {
  return {
    exec: (_id: string, command: string) => {
      log.push(command);
      const hit = replies.find((r) => r.match.test(command));
      if (!hit) return Promise.resolve({ stdout: '', stderr: '', exitCode: 127 });
      return Promise.resolve({
        stdout: hit.stdout ?? '',
        stderr: hit.stderr ?? '',
        exitCode: hit.exitCode ?? 0,
      });
    },
  } as unknown as SshService;
}

const agentLogEnvelope = (lines: string[]): string =>
  JSON.stringify({ count: lines.length, engine: 'claude', lines, path: CLAUDE, session: 'demo-claude' });

describe('sessionConversation', () => {
  it('resolves the transcript id from the session cwd, never from its name', async () => {
    const log: string[] = [];
    const helper = new PocketshellClient(
      fakeSsh(
        [
          { match: /ls -1t/, stdout: `${CLAUDE}\n` },
          { match: /agent-log/, stdout: agentLogEnvelope([CLAUDE_LINE]) },
        ],
        log,
      ),
    );

    const res = await helper.sessionConversation('c1', {
      session: 'main',
      engine: 'claude',
      cwd: '/workspace/demo',
    });

    expect(res.ok).toBe(true);
    expect(res.transcriptId).toBe('demo-claude');
    expect(res.lines).toEqual([CLAUDE_LINE]);
    expect(res.cwdVerified).toBe(true);
    // The regression in one line: the tmux session name must NOT be what gets
    // passed to `--session`, which is what made the tab look empty.
    // Quotes are doubled by the login-shell wrapper (pathAwareCommand), so
    // match on the option and its value rather than on exact quoting.
    const agentLogCall = log.find((c) => c.includes('agent-log'))!;
    expect(agentLogCall).toMatch(/--session '\\''demo-claude/);
    expect(agentLogCall).not.toMatch(/--session '\\''main/);
  });

  it('reports which transcript it chose so the pick is checkable', async () => {
    const helper = new PocketshellClient(
      fakeSsh([
        { match: /ls -1t/, stdout: `${CODEX}\n` },
        { match: /agent-log/, stdout: agentLogEnvelope([CLAUDE_LINE]) },
      ]),
    );
    const res = await helper.sessionConversation('c1', {
      session: 'main',
      engine: 'codex',
      cwd: '/workspace/demo',
    });
    expect(res.ok).toBe(true);
    expect(res.engine).toBe('codex');
    // Codex paths carry no cwd, so the match is by engine + recency and says so.
    expect(res.cwdVerified).toBe(false);
  });

  it('fails with an explanation when no transcript matches the session', async () => {
    const helper = new PocketshellClient(
      fakeSsh([{ match: /ls -1t/, stdout: `${CLAUDE}\n` }]),
    );
    const res = await helper.sessionConversation('c1', {
      session: 'build',
      engine: 'claude',
      cwd: '/workspace/other',
    });
    expect(res.ok).toBe(false);
    // The silent-empty-panel guard: `ok: false` always carries a sentence.
    expect(res.error).toContain('build');
    expect(res.error).toContain('/workspace/other');
    expect(res.lines).toEqual([]);
  });

  it('fails loudly when the host has no transcripts at all', async () => {
    // `ls` exits non-zero with empty stdout when every glob missed — the
    // normal state of a host with no agent history, not an internal error.
    const helper = new PocketshellClient(fakeSsh([{ match: /ls -1t/, exitCode: 2 }]));
    const res = await helper.sessionConversation('c1', {
      session: 'main',
      engine: null,
      cwd: '/workspace/demo',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('reads the file directly when agent-log finds nothing we can see', async () => {
    // Helper drift has cost this app four parser bugs already (docs/ANALYSIS.md
    // "Drift from the v0.4.8 contract"); a transcript we located ourselves must
    // not become an empty panel because the helper's search roots moved.
    const log: string[] = [];
    const helper = new PocketshellClient(
      fakeSsh(
        [
          { match: /ls -1t/, stdout: `${CLAUDE}\n` },
          { match: /agent-log/, exitCode: 66 },
          { match: /tail -n 4000/, stdout: `${CLAUDE_LINE}\n` },
        ],
        log,
      ),
    );
    const res = await helper.sessionConversation('c1', {
      session: 'main',
      engine: 'claude',
      cwd: '/workspace/demo',
    });
    expect(res.ok).toBe(true);
    expect(res.lines).toEqual([CLAUDE_LINE]);
    expect(log.some((c) => c.includes('tail -n 4000') && c.includes(CLAUDE))).toBe(true);
  });

  it('fails with the transcript path when both routes come up empty', async () => {
    const helper = new PocketshellClient(
      fakeSsh([
        { match: /ls -1t/, stdout: `${CLAUDE}\n` },
        { match: /agent-log/, exitCode: 66 },
        { match: /tail -n/, stdout: '' },
      ]),
    );
    const res = await helper.sessionConversation('c1', {
      session: 'main',
      engine: 'claude',
      cwd: '/workspace/demo',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(CLAUDE);
  });
});
