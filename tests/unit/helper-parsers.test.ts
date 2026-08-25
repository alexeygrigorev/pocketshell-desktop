import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseSessionsList,
  parseTmuxListSessionsFallback,
  parseUsageNdjson,
  parseResumableTable,
  parseAgentLogJson,
  parseCommandV,
  parseSessionEnrichment,
  mergeSessionEnrichment,
  agentKindFromTmuxOption,
  SESSION_ENRICHMENT_COMMAND,
} from '@main/helper/parsers';

const FIXTURES = resolve(__dirname, '..', '..', 'tests-docker', 'fixtures');
const readFixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

/**
 * Output captured verbatim from the helper the user actually runs (0.4.44,
 * tmux 3.4). Nothing in here is hand-authored.
 *
 * These four files stay host-captured rather than Docker-captured: the
 * fixture image cannot produce any of them. `sessions list` dies on the
 * tmuxctl `list-sessions` tab bug (tmuxctl#6), `sessions resumable` has no
 * agent history to list, and `usage --json` has no provider credentials, so
 * every row comes back `status: "error"`. The image and the host now run the
 * same pinned 0.4.44, so the two agree on wire format.
 */
const V44 = resolve(__dirname, 'fixtures');
const readV44 = (name: string): string => readFileSync(resolve(V44, name), 'utf8');

describe('parseSessionsList', () => {
  it('parses the real pocketshell-sessions-list.txt fixture', () => {
    const out = parseSessionsList(readFixture('pocketshell-sessions-list.txt'));
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.name)).toEqual(['claude-main', 'codex', 'opencode-lab']);
    const first = out[0]!;
    expect(first.name).toBe('claude-main');
    expect(first.created).toBe(Date.parse('2026-05-23 10:00:00') / 1000);
    expect(first.attached).toBe(false);
  });

  it('skips the header, footer hints, and blank separator lines', () => {
    const text = `
IDX  SESSION               CREATED
1    one                   2026-01-02 03:04:05

Join a session: pocketshell sessions <id>
Create a new one: pocketshell sessions :<session>
`;
    const out = parseSessionsList(text);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('one');
  });

  it('handles multi-word session names', () => {
    const text = '1    my cool session      2026-01-02 03:04:05\n';
    const out = parseSessionsList(text);
    expect(out[0]!.name).toBe('my cool session');
  });

  it('returns [] for empty / no-server output', () => {
    expect(parseSessionsList('')).toEqual([]);
    expect(parseSessionsList('no server running on /tmp/tmux-1000/default\n')).toEqual([]);
  });

  it('parses real 0.4.44 output, including names that overflow the column', () => {
    const out = parseSessionsList(readV44('v0.4.44-sessions-list.txt'));
    expect(out).toHaveLength(15);
    expect(out[0]!.name).toBe('git-red-stamp');
    // `git-ai-dev-tools-zoomcamp` is 25 chars and overruns the SESSION column,
    // leaving a single space before the timestamp.
    expect(out[1]!.name).toBe('git-ai-dev-tools-zoomcamp');
    // 0.4.44 changed the footer hints from `pocketshell sessions <id>` to
    // `tmuxctl <id>`; the timestamp anchor skips them either way.
    expect(out.map((s) => s.name).filter((n) => n.startsWith('Join'))).toEqual([]);
  });

  it('leaves path/attached/agentKind for the companion probe to fill', () => {
    const out = parseSessionsList(readV44('v0.4.44-sessions-list.txt'));
    expect(out.every((s) => s.path === null)).toBe(true);
    expect(out.every((s) => s.attached === false)).toBe(true);
    expect(out.every((s) => s.agentKind === null)).toBe(true);
  });
});

describe('SESSION_ENRICHMENT_COMMAND', () => {
  it('is one `tmux -u list-panes -a` probe with the seven fields we parse', () => {
    expect(SESSION_ENRICHMENT_COMMAND).toContain('tmux -u list-panes -a -F');
    for (const field of [
      '#{session_name}',
      '#{window_active}',
      '#{pane_active}',
      '#{pane_current_path}',
      '#{session_path}',
      '#{session_attached}',
      '#{@ps_agent_kind}',
    ]) {
      expect(SESSION_ENRICHMENT_COMMAND).toContain(field);
    }
  });
});

describe('agentKindFromTmuxOption', () => {
  it('maps every value record_agent_kind can write', () => {
    expect(agentKindFromTmuxOption('claude')).toBe('claude');
    expect(agentKindFromTmuxOption('codex')).toBe('codex');
    expect(agentKindFromTmuxOption('opencode')).toBe('opencode');
    expect(agentKindFromTmuxOption('grok')).toBe('grok');
    expect(agentKindFromTmuxOption('shell')).toBe('shell');
  });

  it('is case- and whitespace-insensitive, mirroring the phone', () => {
    expect(agentKindFromTmuxOption('CLAUDE')).toBe('claude');
    expect(agentKindFromTmuxOption(' codex ')).toBe('codex');
  });

  it('returns null for absent or unrecognised options rather than guessing', () => {
    expect(agentKindFromTmuxOption('')).toBeNull();
    expect(agentKindFromTmuxOption(null)).toBeNull();
    expect(agentKindFromTmuxOption(undefined)).toBeNull();
    // Real value observed on the user's box — a kind we do not know.
    expect(agentKindFromTmuxOption('test-engine')).toBeNull();
  });
});

describe('parseSessionEnrichment', () => {
  const map = parseSessionEnrichment(readV44('v0.4.44-tmux-list-panes.txt'));

  it('covers every live session in the capture', () => {
    expect(map.size).toBe(15);
  });

  it('prefers the active pane cwd over an unexpanded session_path', () => {
    // `git-red-stamp` was created with `-c ~/git`, so session_path is the
    // literal `~/git` while the pane reports the resolved absolute path.
    expect(map.get('git-red-stamp')!.path).toBe('/home/alexey/git');
  });

  it('reads the recorded @ps_agent_kind as the authoritative kind', () => {
    expect(map.get('git-ai-book-generator')!.agentKind).toBe('claude');
    expect(map.get('git-dataops')!.agentKind).toBe('codex');
    expect(map.get('git-pocketshell-quse')!.agentKind).toBe('opencode');
    // No option recorded -> foreign session, not a guess.
    expect(map.get('home-alexey')!.agentKind).toBeNull();
    // Recorded but unrecognised -> also null, never mislabeled.
    expect(map.get('git-pocketshell-2')!.agentKind).toBeNull();
  });

  it('reads session_attached as a count', () => {
    expect(map.get('git-game-tester')!.attached).toBe(true);
    expect(map.get('home-alexey-go')!.attached).toBe(true);
    expect(map.get('git-dataops')!.attached).toBe(false);
  });

  it('lets the active pane win over an earlier inactive pane of the session', () => {
    const out = parseSessionEnrichment(
      'main::0::1::/tmp/other::/home/u::0::\n' +
        'main::1::1::/home/u/git/app::/home/u::0::claude\n' +
        'main::1::0::/tmp/split::/home/u::0::claude\n',
    );
    expect(out.get('main')).toEqual({
      path: '/home/u/git/app',
      attached: false,
      agentKind: 'claude',
    });
  });

  it('falls back to session_path when no pane is active', () => {
    const out = parseSessionEnrichment('main::0::0::/tmp/other::/home/u::2::shell\n');
    expect(out.get('main')).toEqual({ path: '/home/u', attached: true, agentKind: 'shell' });
  });

  it('degrades to an empty map for no-server / short output', () => {
    expect(parseSessionEnrichment('')).toEqual(new Map());
    expect(parseSessionEnrichment('no server running on /tmp/tmux-1000/default\n')).toEqual(
      new Map(),
    );
  });
});

describe('mergeSessionEnrichment', () => {
  it('folds the probe into the bare sessions-list rows', () => {
    const merged = mergeSessionEnrichment(
      parseSessionsList(readV44('v0.4.44-sessions-list.txt')),
      parseSessionEnrichment(readV44('v0.4.44-tmux-list-panes.txt')),
    );
    // The whole point of task 1: no row lands in the Untracked bucket.
    expect(merged.every((s) => s.path !== null)).toBe(true);
    expect(new Set(merged.map((s) => s.path)).size).toBeGreaterThan(1);

    const dataops = merged.find((s) => s.name === 'git-dataops')!;
    expect(dataops.path).toBe('/home/alexey/git/dataops');
    expect(dataops.agentKind).toBe('codex');
    expect(dataops.attached).toBe(false);
    // Three sessions share /home/alexey/git/pocketshell — a real folder group.
    expect(merged.filter((s) => s.path === '/home/alexey/git/pocketshell')).toHaveLength(3);
    expect(merged.filter((s) => s.attached)).toHaveLength(2);
  });

  it('keeps rows untouched when the probe returned nothing for them', () => {
    const bare = parseSessionsList('1    solo   2026-01-02 03:04:05\n');
    expect(mergeSessionEnrichment(bare, new Map())).toEqual(bare);
  });
});

describe('parseTmuxListSessionsFallback', () => {
  it('parses the ::-delimited tmux list-sessions shape', () => {
    const out = parseTmuxListSessionsFallback(
      "main::1716451200::1716454800::1::/home/test/project\n" +
        "build::1716450000::1716454000::0::\n",
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: 'main', created: 1716451200, activity: 1716454800, attached: true, path: '/home/test/project' });
    expect(out[1]).toMatchObject({ name: 'build', attached: false, path: null });
  });

  it('skips the no-server line', () => {
    expect(parseTmuxListSessionsFallback('no server running\n')).toEqual([]);
  });
});

describe('parseUsageNdjson', () => {
  it('skips malformed lines', () => {
    const out = parseUsageNdjson('{"provider":"a"}\nnot json\n{"provider":"b"}\n');
    expect(out.map((u) => u.provider)).toEqual(['a', 'b']);
  });

  it('parses the real 0.4.44 shape: null percentages and window labels', () => {
    const out = parseUsageNdjson(readV44('v0.4.44-usage.ndjson'));
    expect(out.map((u) => u.provider)).toEqual(['claude', 'codex', 'copilot', 'grok', 'zai']);

    const claude = out[0]!;
    expect(claude.short_term.percent_remaining).toBe(92.0);
    expect(claude.short_term.window).toBe('5h');
    expect(claude.long_term.window).toBe('7d');

    // A provider with no short-term window emits nulls rather than omitting
    // the object — anything formatting this MUST guard.
    const codex = out[1]!;
    expect(codex.short_term.percent_remaining).toBeNull();
    expect(codex.short_term.reset_at).toBeNull();
    expect(codex.long_term.percent_remaining).toBe(90.0);

    // `status` stays `ok` even for an exhausted provider; the percentage is
    // the signal, not the status string.
    expect(out[3]!.status).toBe('ok');
    expect(out[3]!.long_term.percent_remaining).toBe(0.0);
  });
});

describe('parseResumableTable', () => {
  const rows = parseResumableTable(readV44('v0.4.44-sessions-resumable.txt'));

  it('parses every row of the real 0.4.44 table', () => {
    expect(rows).toHaveLength(12);
    expect(rows[2]).toMatchObject({ engine: 'codex', project: 'git', when: '1m', running: false });
    expect(rows[2]!.label).toBe(
      'I have this game idea so the idea is I work at the security check at the embass…',
    );
  });

  it('splits `just now` from a label it directly abuts', () => {
    // `{when:<8}` and "just now" is exactly 8 chars, so there is NO whitespace
    // between the two columns on these rows.
    expect(rows[0]).toMatchObject({ engine: 'codex', project: 'dtc-website', when: 'just now' });
    expect(rows[0]!.label).toBe(
      'https://github.com/DataTalksClub/website/issues/182 please take the last image…',
    );
    expect(rows[1]!.when).toBe('just now');
    expect(rows[1]!.label.startsWith('I want to make a browser game')).toBe(true);
  });

  it('recovers a project name that overflows its 20-wide column', () => {
    const row = rows[4]!;
    expect(row.project).toBe('telegram-writing-assistant');
    expect(row.when).toBe('39m');
    expect(row.label.startsWith('articles/claw-drafts/deepseek-harness.md')).toBe(true);
  });

  it('strips the trailing (running) tag', () => {
    const running = rows.filter((r) => r.running);
    expect(running).toHaveLength(4);
    expect(running.every((r) => !r.label.includes('(running)'))).toBe(true);
    expect(rows[3]).toMatchObject({ engine: 'claude', project: 'ai-book-generator', when: '13m', running: true });
  });

  it('returns [] for a header-only table (no resumable conversations)', () => {
    expect(parseResumableTable('IDX ENGINE    PROJECT             WHEN    LABEL\n')).toEqual([]);
  });
});

describe('parseAgentLogJson', () => {
  it('parses the --json envelope', () => {
    const env = {
      count: 2,
      engine: 'claude',
      lines: ['{"role":"user"}', '{"role":"assistant"}'],
      path: '/home/test/.claude/projects/x/s.jsonl',
      session: 's',
    };
    const out = parseAgentLogJson(JSON.stringify(env));
    expect(out).not.toBeNull();
    expect(out!.engine).toBe('claude');
    expect(out!.count).toBe(2);
    expect(out!.lines).toHaveLength(2);
  });

  it('returns null for non-JSON / raw JSONL', () => {
    expect(parseAgentLogJson('{"role":"user"}\n{"role":"assistant"}')).toBeNull();
    expect(parseAgentLogJson('')).toBeNull();
  });
});

describe('parseCommandV', () => {
  it('returns the path on exit 0', () => {
    expect(parseCommandV('/home/test/.local/bin/pocketshell\n', 0)).toBe(
      '/home/test/.local/bin/pocketshell',
    );
  });
  it('returns null on non-zero exit', () => {
    expect(parseCommandV('', 1)).toBeNull();
    expect(parseCommandV('not found', 127)).toBeNull();
  });
});
