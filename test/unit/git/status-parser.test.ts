/**
 * Unit tests for git status parser.
 *
 * Tests parseStatus with various porcelain=v2 outputs.
 */

import { describe, it, expect } from 'vitest';
import { parseStatus } from '../../../src/git/status-parser';

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
