import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseSessionsList,
  parseTmuxListSessionsFallback,
  parseUsageNdjson,
  parseAgentSubcommands,
  parseCommandV,
  parseSessionEnrichment,
  mergeSessionEnrichment,
  agentKindFromTmuxOption,
  inferPathsFromSiblings,
  diagnoseSessionPaths,
  SESSION_ENRICHMENT_COMMAND,
} from '@main/helper/parsers';
import type { SessionSummary } from '../../src/shared/types';

const FIXTURES = resolve(__dirname, '..', '..', 'tests-docker', 'fixtures');
const readFixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

/**
 * Output captured verbatim from the helper the user actually runs (0.4.44,
 * tmux 3.4). Nothing in here is hand-authored.
 *
 * These four files stay host-captured rather than Docker-captured: the
 * fixture image cannot produce any of them. `sessions list` dies on the
 * tmuxctl `list-sessions` tab bug (tmuxctl#6), and `usage --json` has no
 * provider credentials, so every row comes back `status: "error"`. The image and the host now run the
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

/**
 * The shape that left sessions with a null path — captured, not invented.
 *
 * `v0.4.44-tmux-list-panes-mangled.txt` and `v0.4.44-sessions-list-mangled.txt`
 * are the two sides of the join as a single host really produces them when
 * sshd exports no locale. Reproduced on the fixture image (tmux 3.4) by
 * creating four sessions and running both commands verbatim; the sessions-list
 * side is rendered in tmuxctl's own `f"{idx:<4} {name:<21} {created:<20}"`
 * because tmuxctl's list dies on that image for an unrelated reason (#6).
 *
 * The four rows are the four things that used to go wrong, one each:
 *
 *   git-café-guide   non-ASCII name, so the two tmux clients spell it
 *                    differently and the map lookup misses entirely
 *   git-od-ds        a `::` inside both path columns, which shifted the
 *                    scalar tail one field left
 *   git-game-tester  a dead pane, so `pane_current_path` is empty and only
 *                    `session_path` has the answer
 *   git-dataops      the ordinary case, which must not regress
 */
describe('the missing-cwd capture', () => {
  const panes = readV44('v0.4.44-tmux-list-panes-mangled.txt');
  const list = readV44('v0.4.44-sessions-list-mangled.txt');

  it('recovers a path for every session in the capture', () => {
    const merged = mergeSessionEnrichment(parseSessionsList(list), parseSessionEnrichment(panes));
    expect(merged).toHaveLength(4);
    expect(merged.filter((s) => s.path === null)).toEqual([]);
  });

  it('joins a name the un-`-u`-ed tmux client sanitised to underscores', () => {
    // `tmux list-sessions` (no -u, no UTF-8 locale) prints `git-caf_-guide`;
    // `tmux -u list-panes -a` prints the real bytes. Same session, two
    // spellings, and the exact-key lookup between them missed.
    const merged = mergeSessionEnrichment(parseSessionsList(list), parseSessionEnrichment(panes));
    const row = merged.find((s) => s.name === 'git-caf_-guide')!;
    expect(row.path).toBe('/home/testuser/git/red-stamp-sound');
    expect(row.agentKind).toBe('claude');
  });

  it('keeps a `::` inside a path whole, and the scalar tail with it', () => {
    const map = parseSessionEnrichment(panes);
    expect(map.get('git-od-ds')).toEqual({
      // Not truncated at the delimiter, which is what the old left-to-right
      // split did — it reported `/home/testuser/git/od`.
      path: '/home/testuser/git/od::ds',
      attached: false,
      agentKind: null,
    });
  });

  it('falls back to session_path for a pane with no live process', () => {
    expect(parseSessionEnrichment(panes).get('git-game-tester')!.path).toBe(
      '/home/testuser/git/game-tester',
    );
  });

  it('refuses a lenient match that two sessions would both claim', () => {
    // Attaching one session's directory to another is worse than the missing
    // path this leniency exists to fix, so an ambiguous key is dropped.
    const map = parseSessionEnrichment(
      'git-á::1::1::/home/u/a::/home/u/a::0::\n' + 'git-é::1::1::/home/u/b::/home/u/b::0::\n',
    );
    const bare = parseSessionsList('1    git-_    2026-01-02 03:04:05\n');
    expect(mergeSessionEnrichment(bare, map)[0]!.path).toBeNull();
  });
});

describe('parseSessionEnrichment row splitting', () => {
  it('keeps a row whose trailing fields are missing rather than dropping it', () => {
    // A tmux too old for `#{@…}`, or a read cut short, loses the TAIL. The
    // row still says where the session is, which is the one thing it is for.
    const out = parseSessionEnrichment('main::1::1::/home/u/app::/home/u\n');
    expect(out.get('main')).toEqual({ path: '/home/u/app', attached: false, agentKind: null });
  });

  it('still skips lines with no path column at all', () => {
    expect(parseSessionEnrichment('main::1::1\nno server running\n')).toEqual(new Map());
  });

  it('trims the name so it matches the trimmed sessions-list name', () => {
    const out = parseSessionEnrichment('  main::1::1::/home/u::/home/u::0::\n');
    expect(out.has('main')).toBe(true);
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

/**
 * The capability probe behind the launch picker's Grok option.
 *
 * The positive case cannot be a fixture: `pocketshell agent grok` exists in the
 * helper's repo but in no RELEASED helper, so there is no host to capture a
 * grok-listing `--help` from. Rather than hand-author a whole fake file and let
 * it drift, the grok row is SPLICED into the real 0.4.44 capture — so the shape
 * being parsed stays the shape the helper actually prints, and only the one
 * line under test is synthetic.
 */
describe('parseAgentSubcommands', () => {
  const agentHelp = readV44('v0.4.44-agent-help.txt');

  it('reads the three subcommands out of the real 0.4.44 capture', () => {
    expect(parseAgentSubcommands(agentHelp, 0)).toEqual(['claude', 'codex', 'opencode']);
  });

  it('picks up a grok row appended to that same shape', () => {
    const withGrok = `${agentHelp.trimEnd()}\n  grok      Launch \`grok\` in --dir with first-run prompts suppressed.\n`;
    expect(parseAgentSubcommands(withGrok, 0)).toEqual([
      'claude',
      'codex',
      'opencode',
      'grok',
    ]);
  });

  it('is null, not [], when the host could not be asked', () => {
    // The distinction the launch picker acts on: null keeps the pinned
    // baseline offered, whereas [] would read as "this host launches nothing".
    expect(parseAgentSubcommands(agentHelp, 2)).toBeNull();
    expect(parseAgentSubcommands('', 0)).toBeNull();
    expect(parseAgentSubcommands('pocketshell: command not found\n', 127)).toBeNull();
    expect(parseAgentSubcommands('Usage: pocketshell agent [OPTIONS]\n', 0)).toBeNull();
    expect(parseAgentSubcommands('Commands:\n', 0)).toBeNull();
  });

  it('keeps a wrapped description out of the names', () => {
    // click indents continuation lines to the description column; treating one
    // as a subcommand would invent an engine, and stopping at one would hide
    // every engine listed after it.
    const wrapped = [
      'Commands:',
      '  claude    Launch `claude` in --dir with first-run prompts',
      '            suppressed and the folder env merged.',
      '  codex     Launch `codex` in --dir.',
      '',
    ].join('\n');
    expect(parseAgentSubcommands(wrapped, 0)).toEqual(['claude', 'codex']);
  });

  it('stops at the next unindented section', () => {
    const trailing = ['Commands:', '  claude    Launch `claude`.', '', 'Options:', '  -h, --help'].join(
      '\n',
    );
    expect(parseAgentSubcommands(trailing, 0)).toEqual(['claude']);
  });

  it('survives CRLF, which is how the exec can hand it back', () => {
    expect(parseAgentSubcommands(agentHelp.replace(/\n/g, '\r\n'), 0)).toEqual([
      'claude',
      'codex',
      'opencode',
    ]);
  });
});

/**
 * docs/WORKSPACE.md §6 — the orphan problem. Both of these exist because the
 * folder workspace keys everything on the folder, so a session with a null
 * path has nowhere to live and must not silently vanish.
 */
describe('inferPathsFromSiblings', () => {
  const row = (name: string, path: string | null): SessionSummary => ({
    name,
    created: 1,
    activity: 1,
    attached: false,
    path,
    agentKind: null,
  });

  it('adopts the path of the session the orphan is named after', () => {
    // The two pairs the user circled on the screenshot.
    const out = inferPathsFromSiblings([
      row('git-dtc-website', '/home/alexey/git/dtc-website'),
      row('git-dtc-website-import', null),
      row('git-red-stamp', '/home/alexey/git/red-stamp'),
      row('git-red-stamp-sound', null),
    ]);
    expect(out[1]).toMatchObject({
      path: '/home/alexey/git/dtc-website',
      pathInferred: true,
    });
    expect(out[3]).toMatchObject({ path: '/home/alexey/git/red-stamp', pathInferred: true });
  });

  it('takes the LONGEST matching sibling', () => {
    const out = inferPathsFromSiblings([
      row('git-a', '/home/a'),
      row('git-a-b', '/home/a/b'),
      row('git-a-b-c', null),
    ]);
    expect(out[2]).toMatchObject({ path: '/home/a/b' });
  });

  it('requires the `-` boundary, so a longer name is not claimed', () => {
    const out = inferPathsFromSiblings([
      row('git-red-stamp', '/home/alexey/git/red-stamp'),
      row('git-red-stampede', null),
    ]);
    expect(out[1]!.path).toBeNull();
    expect(out[1]!.pathInferred).toBeUndefined();
  });

  it('leaves a session with no matching sibling unplaced rather than guessing', () => {
    const out = inferPathsFromSiblings([row('git-x', '/home/x'), row('git-auth', null)]);
    expect(out[1]!.path).toBeNull();
  });

  it('never rewrites a session that already reported a path', () => {
    const rows = [row('git-a', '/home/a'), row('git-a-b', '/home/elsewhere')];
    expect(inferPathsFromSiblings(rows)[1]).toBe(rows[1]);
  });
});

describe('diagnoseSessionPaths', () => {
  const row = (name: string, path: string | null, inferred = false): SessionSummary => ({
    name,
    created: 1,
    activity: 1,
    attached: false,
    path,
    agentKind: null,
    ...(inferred ? { pathInferred: true } : {}),
  });
  const probeRow = (path: string | null) => ({ path, attached: false, agentKind: null });

  it('says nothing when every session placed', () => {
    const report = diagnoseSessionPaths(
      [row('git-a', '/home/a')],
      new Map([['git-a', probeRow('/home/a')]]),
    );
    expect(report.unplaced).toEqual([]);
    expect(report.unmatchedProbeKeys).toEqual([]);
  });

  it('reports `absent` when the probe emitted no row at all', () => {
    const report = diagnoseSessionPaths([row('git-auth', null)], new Map());
    expect(report.unplaced).toEqual([
      { name: 'git-auth', probe: 'absent', lenientKey: 'git-auth', inferred: false },
    ]);
  });

  it('reports `no-path` when a row was there with both path columns empty', () => {
    const report = diagnoseSessionPaths(
      [row('git-auth', null)],
      new Map([['git-auth', probeRow(null)]]),
    );
    expect(report.unplaced[0]).toMatchObject({ probe: 'no-path' });
  });

  it('reports `ambiguous` when the drop-on-collision rule fired', () => {
    // Two non-ASCII names collapsing to one column-sanitised key: 3ac7abc
    // drops the key rather than attaching one session's cwd to another.
    const report = diagnoseSessionPaths(
      [row('git-caf_', null)],
      new Map([
        ['git-café', probeRow('/home/a')],
        ['git-cafè', probeRow('/home/b')],
      ]),
    );
    expect(report.unplaced[0]).toMatchObject({ probe: 'ambiguous', lenientKey: 'git-caf_' });
  });

  it('still reports a session whose path came from a sibling', () => {
    const report = diagnoseSessionPaths([row('git-a-b', '/home/a', true)], new Map());
    expect(report.unplaced[0]).toMatchObject({ inferred: true, probe: 'absent' });
  });

  it('names probe rows that matched no listed session', () => {
    const report = diagnoseSessionPaths(
      [row('git-a', '/home/a')],
      new Map([
        ['git-a', probeRow('/home/a')],
        ['ghost', probeRow('/home/g')],
      ]),
    );
    expect(report.unmatchedProbeKeys).toEqual(['ghost']);
  });
});
