/**
 * Unit tests for git status parser.
 *
 * Tests parseStatus with various porcelain=v2 outputs.
 */

import { describe, it, expect } from 'vitest';
import {
  parseStatus,
  parseGitHubIssues,
  parseGhStatus,
  DEFAULT_GH_HINT,
} from '../../../src/git/status-parser';

describe('parseStatus', () => {
  it('parses clean status', () => {
    const output = [
      '# branch.oid abc123def456789',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
    ].join('\n');

    const status = parseStatus(output);

    expect(status.branch).toBe('main');
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
    expect(status.isClean).toBe(true);
  });

  it('parses modified files', () => {
    const output = [
      '# branch.oid abc123def456789',
      '# branch.head main',
      '# branch.ab +0 -0',
      '1 .M N... 100644 100644 100644 abc123 def456 file.txt',
    ].join('\n');

    const status = parseStatus(output);

    expect(status.branch).toBe('main');
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([
      { path: 'file.txt', status: 'modified' },
    ]);
    expect(status.isClean).toBe(false);
  });

  it('parses staged + unstaged changes', () => {
    const output = [
      '# branch.oid abc123def456789',
      '# branch.head main',
      '# branch.ab +0 -0',
      '1 MM N... 100644 100644 100644 abc123 def456 readme.md',
      '1 AM N... 100644 100644 100644 abc123 def456 new-file.ts',
    ].join('\n');

    const status = parseStatus(output);

    expect(status.staged).toEqual([
      { path: 'readme.md', status: 'modified' },
      { path: 'new-file.ts', status: 'added' },
    ]);
    expect(status.unstaged).toEqual([
      { path: 'readme.md', status: 'modified' },
      { path: 'new-file.ts', status: 'modified' },
    ]);
  });

  it('parses untracked files', () => {
    const output = [
      '# branch.oid abc123def456789',
      '# branch.head main',
      '# branch.ab +0 -0',
      '? untracked-1.txt',
      '? untracked-2.txt',
      '? dir/untracked-3.txt',
    ].join('\n');

    const status = parseStatus(output);

    expect(status.untracked).toEqual([
      'untracked-1.txt',
      'untracked-2.txt',
      'dir/untracked-3.txt',
    ]);
    expect(status.isClean).toBe(false);
  });

  it('parses ahead/behind counts', () => {
    const output = [
      '# branch.oid abc123def456789',
      '# branch.head feature',
      '# branch.upstream origin/feature',
      '# branch.ab +3 -1',
    ].join('\n');

    const status = parseStatus(output);

    expect(status.branch).toBe('feature');
    expect(status.ahead).toBe(3);
    expect(status.behind).toBe(1);
  });

  it('parses renamed files', () => {
    const output = [
      '# branch.oid abc123def456789',
      '# branch.head main',
      '# branch.ab +0 -0',
      '2 RM N... 100644 100644 100644 abc123 def456 R100 old-name.txt new-name.txt',
    ].join('\n');

    const status = parseStatus(output);

    expect(status.staged).toEqual([
      { path: 'new-name.txt', status: 'renamed', oldPath: 'old-name.txt' },
    ]);
    expect(status.unstaged).toEqual([
      { path: 'new-name.txt', status: 'modified' },
    ]);
  });

  it('parses deleted files', () => {
    const output = [
      '# branch.oid abc123def456789',
      '# branch.head main',
      '# branch.ab +0 -0',
      '1 D  N... 100644 100644 100644 abc123 def456 deleted-file.txt',
    ].join('\n');

    const status = parseStatus(output);

    expect(status.staged).toEqual([
      { path: 'deleted-file.txt', status: 'deleted' },
    ]);
    expect(status.unstaged).toEqual([]);
  });

  it('parses empty output', () => {
    const status = parseStatus('');

    expect(status.branch).toBe('');
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.isClean).toBe(true);
  });

  it('handles detached HEAD', () => {
    const output = [
      '# branch.oid abc123def456789',
      '# branch.head (detached)',
      '# branch.ab +0 -0',
    ].join('\n');

    const status = parseStatus(output);
    expect(status.branch).toBe('(detached)');
  });

  it('handles file paths with spaces', () => {
    const output = [
      '# branch.oid abc123def456789',
      '# branch.head main',
      '# branch.ab +0 -0',
      '1 .M N... 100644 100644 100644 abc123 def456 path with spaces.txt',
    ].join('\n');

    const status = parseStatus(output);
    expect(status.unstaged).toEqual([
      { path: 'path with spaces.txt', status: 'modified' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseGitHubIssues — `gh issue list --json number,title,state,labels,updatedAt`
// (mirrors GitHubIssueParser.kt)
// ---------------------------------------------------------------------------

describe('parseGitHubIssues', () => {
  it('parses a typical gh issue list payload', () => {
    const raw = JSON.stringify([
      {
        number: 649,
        title: 'view GitHub issues in-app',
        state: 'OPEN',
        labels: [{ name: 'enhancement', color: 'a2eeef' }, { name: 'ui' }],
        updatedAt: '2026-06-09T10:11:12Z',
      },
      {
        number: 100,
        title: 'A closed one',
        state: 'CLOSED',
        labels: [],
        updatedAt: '2026-05-01T08:00:00Z',
      },
    ]);
    const issues = parseGitHubIssues(raw);
    expect(issues).toEqual([
      {
        number: 649,
        title: 'view GitHub issues in-app',
        state: 'open',
        labels: ['enhancement', 'ui'],
        updatedAt: '2026-06-09T10:11:12Z',
      },
      {
        number: 100,
        title: 'A closed one',
        state: 'closed',
        labels: [],
        updatedAt: '2026-05-01T08:00:00Z',
      },
    ]);
  });

  it('returns an empty list for empty / whitespace input (never throws)', () => {
    expect(parseGitHubIssues('')).toEqual([]);
    expect(parseGitHubIssues('   \n  ')).toEqual([]);
  });

  it('returns an empty list for malformed JSON', () => {
    expect(parseGitHubIssues('not json')).toEqual([]);
    expect(parseGitHubIssues('{not an array')).toEqual([]);
  });

  it('returns an empty list for a non-array JSON value', () => {
    expect(parseGitHubIssues('{"number": 1}')).toEqual([]);
    expect(parseGitHubIssues('"string"')).toEqual([]);
    expect(parseGitHubIssues('null')).toEqual([]);
  });

  it('skips entries missing a usable number (<=0 or non-numeric)', () => {
    const raw = JSON.stringify([
      { number: 0, title: 'zero', state: 'OPEN', labels: [] },
      { number: -5, title: 'neg', state: 'OPEN', labels: [] },
      { title: 'no number field', state: 'OPEN', labels: [] },
      { number: 'abc', title: 'non-numeric', state: 'OPEN', labels: [] },
      { number: 42, title: 'good', state: 'OPEN', labels: [] },
    ]);
    const issues = parseGitHubIssues(raw);
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(42);
    expect(issues[0].title).toBe('good');
  });

  it('skips non-object array entries', () => {
    const raw = JSON.stringify([null, 'string', 5, { number: 1, title: 'x', state: 'OPEN', labels: [] }]);
    const issues = parseGitHubIssues(raw);
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
  });

  it('accepts a numeric-string number field (parses to int)', () => {
    const raw = JSON.stringify([{ number: '123', title: 's', state: 'OPEN', labels: [] }]);
    const issues = parseGitHubIssues(raw);
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(123);
  });

  it('coerces an unknown state to "unknown" (forward-compatible, keeps the row)', () => {
    const raw = JSON.stringify([{ number: 1, title: 'x', state: 'LOCKED', labels: [] }]);
    const issues = parseGitHubIssues(raw);
    expect(issues).toHaveLength(1);
    expect(issues[0].state).toBe('unknown');
  });

  it('treats state case-insensitively', () => {
    const raw = JSON.stringify([
      { number: 1, title: 'a', state: 'open', labels: [] },
      { number: 2, title: 'b', state: 'Closed', labels: [] },
    ]);
    const issues = parseGitHubIssues(raw);
    expect(issues[0].state).toBe('open');
    expect(issues[1].state).toBe('closed');
  });

  it('parses label names and drops blank/missing ones', () => {
    const raw = JSON.stringify([{
      number: 1,
      title: 'x',
      state: 'OPEN',
      labels: [
        { name: 'bug', color: 'red' },
        { name: '   ', color: 'blue' },
        { color: 'green' },
        'not-an-object',
        null,
        { name: 'ui' },
      ],
    }]);
    const issues = parseGitHubIssues(raw);
    expect(issues[0].labels).toEqual(['bug', 'ui']);
  });

  it('treats a missing labels field as an empty list', () => {
    const raw = JSON.stringify([{ number: 1, title: 'x', state: 'OPEN' }]);
    const issues = parseGitHubIssues(raw);
    expect(issues[0].labels).toEqual([]);
  });

  it('trims title + updatedAt, and leaves updatedAt undefined when blank', () => {
    const raw = JSON.stringify([
      { number: 1, title: '  spaced  ', state: 'OPEN', labels: [], updatedAt: '  2026-01-02  ' },
      { number: 2, title: 'x', state: 'OPEN', labels: [], updatedAt: '' },
    ]);
    const issues = parseGitHubIssues(raw);
    expect(issues[0].title).toBe('spaced');
    expect(issues[0].updatedAt).toBe('2026-01-02');
    expect(issues[1].updatedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseGhStatus — `pocketshell github status --json`
// (mirrors GhConfigStatus.parseGhStatus)
// ---------------------------------------------------------------------------

describe('parseGhStatus', () => {
  it('parses the configured state with an account', () => {
    const raw = JSON.stringify({
      installed: true,
      authenticated: true,
      account: 'alexeygrigorev',
      hint: null,
    });
    expect(parseGhStatus(raw)).toEqual({
      installed: true,
      authenticated: true,
      account: 'alexeygrigorev',
    });
  });

  it('parses the configured state with a missing/blank account', () => {
    const raw = JSON.stringify({ installed: true, authenticated: true, account: '' });
    expect(parseGhStatus(raw)).toEqual({
      installed: true,
      authenticated: true,
      account: undefined,
    });
  });

  it('parses the not-configured state with a hint', () => {
    const raw = JSON.stringify({
      installed: false,
      authenticated: false,
      account: null,
      hint: 'install gh and run `gh auth login`',
    });
    expect(parseGhStatus(raw)).toEqual({
      installed: false,
      authenticated: false,
      hint: 'install gh and run `gh auth login`',
    });
  });

  it('parses installed-but-not-authed as not-configured', () => {
    const raw = JSON.stringify({
      installed: true,
      authenticated: false,
      hint: 'run `gh auth login`',
    });
    const status = parseGhStatus(raw);
    expect(status.installed).toBe(true);
    expect(status.authenticated).toBe(false);
    expect(status.hint).toBe('run `gh auth login`');
    expect(status.account).toBeUndefined();
  });

  it('falls back to DEFAULT_GH_HINT for empty input', () => {
    expect(parseGhStatus('')).toEqual({
      installed: false,
      authenticated: false,
      hint: DEFAULT_GH_HINT,
    });
    expect(parseGhStatus('   ')).toEqual({
      installed: false,
      authenticated: false,
      hint: DEFAULT_GH_HINT,
    });
  });

  it('falls back to DEFAULT_GH_HINT for malformed JSON', () => {
    expect(parseGhStatus('not json')).toEqual({
      installed: false,
      authenticated: false,
      hint: DEFAULT_GH_HINT,
    });
  });

  it('falls back to DEFAULT_GH_HINT when the hint field is blank', () => {
    const raw = JSON.stringify({ installed: false, authenticated: false, hint: '  ' });
    expect(parseGhStatus(raw).hint).toBe(DEFAULT_GH_HINT);
  });

  it('falls back to DEFAULT_GH_HINT for a non-object JSON value', () => {
    expect(parseGhStatus('42').hint).toBe(DEFAULT_GH_HINT);
    expect(parseGhStatus('null').hint).toBe(DEFAULT_GH_HINT);
  });
});
