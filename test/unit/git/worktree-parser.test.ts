/**
 * Unit tests for the git worktree parser (`git worktree list --porcelain`).
 */

import { describe, it, expect } from 'vitest';
import { parseWorktree } from '../../../src/git/status-parser';

describe('parseWorktree', () => {
  it('returns an empty array for empty input', () => {
    expect(parseWorktree('')).toEqual([]);
    expect(parseWorktree('   \n  \n')).toEqual([]);
  });

  it('parses a single main worktree with a branch', () => {
    const output = [
      'worktree /home/user/repo',
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'branch refs/heads/main',
      '',
    ].join('\n');

    const worktrees = parseWorktree(output);

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toEqual({
      path: '/home/user/repo',
      head: '0123456789abcdef0123456789abcdef01234567',
      branch: 'refs/heads/main',
      isMain: true,
      isBare: false,
      isLocked: false,
      isPrunable: false,
      reason: undefined,
    });
  });

  it('parses multiple worktrees and marks only the first as main', () => {
    const output = [
      'worktree /home/user/repo',
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'branch refs/heads/main',
      '',
      'worktree /home/user/repo-feature',
      'HEAD fedcba9876543210fedcba9876543210fedcba98',
      'branch refs/heads/feature',
      '',
    ].join('\n');

    const worktrees = parseWorktree(output);

    expect(worktrees).toHaveLength(2);
    expect(worktrees[0].isMain).toBe(true);
    expect(worktrees[0].path).toBe('/home/user/repo');
    expect(worktrees[1].isMain).toBe(false);
    expect(worktrees[1].path).toBe('/home/user/repo-feature');
    expect(worktrees[1].branch).toBe('refs/heads/feature');
  });

  it('handles detached HEAD (no branch field)', () => {
    const output = [
      'worktree /home/user/repo',
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'detached',
      '',
    ].join('\n');

    const worktrees = parseWorktree(output);

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].branch).toBeUndefined();
  });

  it('parses a bare repository entry', () => {
    const output = [
      'bare',
      '',
      'worktree /home/user/repo',
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'branch refs/heads/main',
      '',
    ].join('\n');

    const worktrees = parseWorktree(output);

    expect(worktrees).toHaveLength(2);
    expect(worktrees[0].isBare).toBe(true);
    expect(worktrees[0].isMain).toBe(true);
    expect(worktrees[0].path).toBe('');
    expect(worktrees[1].isBare).toBe(false);
    expect(worktrees[1].path).toBe('/home/user/repo');
  });

  it('parses locked + prunable flags with reasons', () => {
    const output = [
      'worktree /home/user/repo',
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'branch refs/heads/main',
      '',
      'worktree /home/user/repo-old',
      'HEAD fedcba9876543210fedcba9876543210fedcba98',
      'branch refs/heads/old',
      'locked manual reason',
      '',
      'worktree /home/user/repo-stale',
      'HEAD 1111111111111111111111111111111111111111',
      'detached',
      'prunable git worktree prune',
      '',
    ].join('\n');

    const worktrees = parseWorktree(output);

    expect(worktrees[1].isLocked).toBe(true);
    expect(worktrees[1].reason).toBe('manual reason');
    expect(worktrees[2].isPrunable).toBe(true);
    expect(worktrees[2].reason).toBe('git worktree prune');
  });

  it('parses bare locked/prunable flags without a reason', () => {
    const output = [
      'worktree /home/user/repo',
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'branch refs/heads/main',
      '',
      'worktree /home/user/repo-x',
      'HEAD fedcba9876543210fedcba9876543210fedcba98',
      'branch refs/heads/x',
      'locked',
      '',
    ].join('\n');

    const worktrees = parseWorktree(output);

    expect(worktrees[1].isLocked).toBe(true);
    expect(worktrees[1].reason).toBeUndefined();
  });

  it('skips malformed records without a worktree line or bare marker', () => {
    const output = [
      'garbage line',
      '',
      'worktree /home/user/repo',
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'branch refs/heads/main',
      '',
    ].join('\n');

    const worktrees = parseWorktree(output);

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].path).toBe('/home/user/repo');
  });
});
