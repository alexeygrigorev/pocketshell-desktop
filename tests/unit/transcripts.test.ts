import { describe, expect, it } from 'vitest';
import {
  TRANSCRIPT_PROBE_COMMAND,
  cwdMatchesProjectDir,
  describeUnresolved,
  parseTranscriptProbe,
  pickTranscript,
  transcriptEngineFromAgentKind,
  type TranscriptCandidate,
} from '@main/agents/transcripts';

/**
 * Pins the "which conversation belongs to this session" resolver.
 *
 * The rule these tests exist to protect is the one the Conversation tab was
 * broken by: `agent-log --session` takes the ENGINE'S transcript id, not the
 * tmux session name, and there is no helper listing that maps between them.
 * Everything here is about recovering that id honestly — and about refusing
 * to invent one, since a wrong conversation shown confidently is worse than
 * an error message.
 */

/** The layout the helper test image seeds, and the shape a real host has. */
const CLAUDE = '/home/testuser/.claude/projects/-workspace-demo/demo-claude.jsonl';
const CLAUDE_OTHER = '/home/testuser/.claude/projects/-home-testuser-git-other/abc-123.jsonl';
const CODEX = '/home/testuser/.codex/sessions/2026/05/23/demo-codex.jsonl';
const OPENCODE = '/home/testuser/.local/share/opencode/demo-opencode.jsonl';

const probeOutput = [CLAUDE, CODEX, OPENCODE, CLAUDE_OTHER].join('\n');

describe('TRANSCRIPT_PROBE_COMMAND', () => {
  it('interpolates nothing and covers all three engine roots', () => {
    // No user data reaches this command, which is why it needs no quoting.
    expect(TRANSCRIPT_PROBE_COMMAND).not.toMatch(/\$\{/);
    expect(TRANSCRIPT_PROBE_COMMAND).toContain('.claude/projects');
    expect(TRANSCRIPT_PROBE_COMMAND).toContain('.codex/sessions');
    expect(TRANSCRIPT_PROBE_COMMAND).toContain('.local/share/opencode');
    // busybox `ls -t` is the portable mtime sort; `find -printf` is not.
    expect(TRANSCRIPT_PROBE_COMMAND.startsWith('ls -1t ')).toBe(true);
    // A missing engine makes ls complain about that one glob only.
    expect(TRANSCRIPT_PROBE_COMMAND).toContain('2>/dev/null');
  });
});

describe('transcriptEngineFromAgentKind', () => {
  it('passes through the three engines agent-log can read', () => {
    expect(transcriptEngineFromAgentKind('claude')).toBe('claude');
    expect(transcriptEngineFromAgentKind('codex')).toBe('codex');
    expect(transcriptEngineFromAgentKind('opencode')).toBe('opencode');
  });

  it('treats shell, grok and an absent option as "we do not know"', () => {
    // Not "no conversation": a session we did not launch can still be running
    // claude, so this must fall through to path-proof matching.
    expect(transcriptEngineFromAgentKind('shell')).toBeNull();
    expect(transcriptEngineFromAgentKind('grok')).toBeNull();
    expect(transcriptEngineFromAgentKind('unknown')).toBeNull();
    expect(transcriptEngineFromAgentKind(null)).toBeNull();
    expect(transcriptEngineFromAgentKind(undefined)).toBeNull();
  });
});

describe('cwdMatchesProjectDir', () => {
  it('matches claude\'s separator encoding of an absolute cwd', () => {
    expect(cwdMatchesProjectDir('-workspace-demo', '/workspace/demo')).toBe(true);
    expect(cwdMatchesProjectDir('-home-alexey-git-app', '/home/alexey/git/app')).toBe(true);
  });

  it('flattens dots and underscores the same way on both sides', () => {
    expect(cwdMatchesProjectDir('-home-me-git-my-app', '/home/me/git/my.app')).toBe(true);
    expect(cwdMatchesProjectDir('-home-me-git-my-app', '/home/me/git/my_app')).toBe(true);
  });

  it('refuses a different project', () => {
    expect(cwdMatchesProjectDir('-workspace-demo', '/workspace/other')).toBe(false);
    expect(cwdMatchesProjectDir('-workspace-demo', '')).toBe(false);
  });

  it('suffix-matches ONLY a cwd tmux left tilde-relative', () => {
    // `session_path` really can be a literal unexpanded `~/git` (parsers.ts),
    // and we cannot expand it here.
    expect(cwdMatchesProjectDir('-home-alexey-git-app', '~/git/app')).toBe(true);
    // An absolute cwd must match exactly, so two same-named projects under
    // different roots can never be confused for one another.
    expect(cwdMatchesProjectDir('-home-alexey-git-app', '/srv/git/app')).toBe(false);
  });
});

describe('parseTranscriptProbe', () => {
  it('classifies each path by engine and keeps the newest-first order', () => {
    const found = parseTranscriptProbe(probeOutput, '/workspace/demo');
    expect(found.map((c) => c.engine)).toEqual(['claude', 'codex', 'opencode', 'claude']);
    expect(found.map((c) => c.id)).toEqual([
      'demo-claude',
      'demo-codex',
      'demo-opencode',
      'abc-123',
    ]);
  });

  it('marks only the claude transcript whose path encodes the cwd', () => {
    const found = parseTranscriptProbe(probeOutput, '/workspace/demo');
    expect(found.filter((c) => c.cwdVerified).map((c) => c.path)).toEqual([CLAUDE]);
  });

  it('never claims cwd proof for codex or opencode', () => {
    // Their cwd lives inside the file, not in the path — see transcripts.ts.
    const found = parseTranscriptProbe([CODEX, OPENCODE].join('\n'), '/workspace/demo');
    expect(found.every((c) => !c.cwdVerified)).toBe(true);
  });

  it('skips noise, blank lines and non-transcript paths', () => {
    const found = parseTranscriptProbe(
      ["ls: cannot access '/home/x/.codex/sessions/*.jsonl'", '', '/tmp/random.jsonl', CLAUDE].join(
        '\n',
      ),
      '/workspace/demo',
    );
    expect(found.map((c) => c.path)).toEqual([CLAUDE]);
  });
});

describe('pickTranscript', () => {
  const found = (cwd: string | null): TranscriptCandidate[] =>
    parseTranscriptProbe(probeOutput, cwd);

  it('prefers the transcript whose path proves the cwd', () => {
    const pick = pickTranscript(found('/workspace/demo'), 'claude', '/workspace/demo');
    expect(pick?.path).toBe(CLAUDE);
    expect(pick?.cwdVerified).toBe(true);
  });

  it('refuses to guess when the engine is unknown and nothing proves the cwd', () => {
    // The failure mode this exists to prevent: showing the newest conversation
    // on the whole host for a session it has nothing to do with.
    expect(pickTranscript(found('/workspace/elsewhere'), null, '/workspace/elsewhere')).toBeNull();
  });

  it('refuses a claude session whose cwd matches no project directory', () => {
    // claude DOES encode the cwd, so "no match" means "no conversation here",
    // never "show another project's".
    expect(
      pickTranscript(found('/workspace/elsewhere'), 'claude', '/workspace/elsewhere'),
    ).toBeNull();
  });

  it('takes the newest of a recorded engine that cannot encode a cwd', () => {
    const pick = pickTranscript(found('/workspace/elsewhere'), 'codex', '/workspace/elsewhere');
    expect(pick?.path).toBe(CODEX);
    // Flagged, so the UI can say how it was matched instead of implying proof.
    expect(pick?.cwdVerified).toBe(false);
  });

  it('takes the newest of a recorded engine when the session has no cwd', () => {
    const pick = pickTranscript(found(null), 'claude', null);
    expect(pick?.path).toBe(CLAUDE);
  });

  it('returns null when the recorded engine has no transcripts at all', () => {
    expect(pickTranscript(parseTranscriptProbe(CLAUDE, null), 'codex', null)).toBeNull();
  });
});

describe('describeUnresolved', () => {
  it('names the session, the engine and the cwd it searched', () => {
    const msg = describeUnresolved('main', 'claude', '/workspace/demo', 4);
    expect(msg).toContain('main');
    expect(msg).toContain('claude');
    expect(msg).toContain('/workspace/demo');
  });

  it('explains the untagged-session case rather than saying "not found"', () => {
    const msg = describeUnresolved('main', null, '/workspace/demo', 4);
    expect(msg).toContain('@ps_agent_kind');
  });

  it('says so when the session reports no working directory', () => {
    expect(describeUnresolved('main', 'codex', null, 0)).toContain('no working directory');
  });
});
