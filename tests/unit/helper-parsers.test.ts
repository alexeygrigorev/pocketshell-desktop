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
} from '@main/helper/parsers';

const FIXTURES = resolve(__dirname, '..', '..', 'tests-docker', 'fixtures');
const readFixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

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
  it('parses the real pocketshell-usage.ndjson fixture', () => {
    const out = parseUsageNdjson(readFixture('pocketshell-usage.ndjson'));
    expect(out).toHaveLength(3);
    expect(out.map((u) => u.provider)).toEqual(['codex', 'claude', 'copilot']);
    const claude = out[1]!;
    expect(claude.status).toBe('limited');
    expect(claude.short_term.percent_remaining).toBe(15.0);
    expect(claude.block_reason).toBe('5h budget nearly exhausted');
    expect(claude.short_term.reset_at).toBe('2026-05-24T14:30:00Z');
  });

  it('skips malformed lines', () => {
    const out = parseUsageNdjson('{"provider":"a"}\nnot json\n{"provider":"b"}\n');
    expect(out.map((u) => u.provider)).toEqual(['a', 'b']);
  });
});

describe('parseResumableTable', () => {
  it('parses IDX/ENGINE/PROJECT/WHEN/LABEL rows', () => {
    // Mirrors the real _format_resumable_table column widths:
    //   IDX[0:4) ENGINE[4:14) PROJECT[14:34) WHEN[34:42) LABEL[42:end)
    // WHEN may overflow ("just now" = 9 chars > 8) but is still separated from
    // LABEL by a 2+-space gap, which the parser keys on.
    const text = [
      'IDX ENGINE    PROJECT              WHEN     LABEL',
      '1   claude    pocketshell          3h       fix the parser',
      '2   codex     pocketshell          1d       (running)',
      '3   opencode  other-proj           just now  hello world label',
      '',
    ].join('\n');
    const out = parseResumableTable(text);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ engine: 'claude', project: 'pocketshell', when: '3h', label: 'fix the parser', running: false });
    expect(out[1]).toMatchObject({ engine: 'codex', running: true, label: '' });
    expect(out[2]!.label).toBe('hello world label');
    expect(out[2]!.when).toBe('just now');
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
