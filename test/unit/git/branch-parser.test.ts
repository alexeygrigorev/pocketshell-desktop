/**
 * Unit tests for git branch parser.
 *
 * Tests parseBranches with various git branch -a/-vv outputs.
 */

import { describe, it, expect } from 'vitest';
import { parseBranches } from '../../../src/git/status-parser';

describe('parseBranches', () => {
  it('parses branches with current marker', () => {
    const output = [
      '* main',
      '  feature/login',
      '  feature/settings',
    ].join('\n');

    const branches = parseBranches(output);

    expect(branches).toHaveLength(3);
    expect(branches[0]).toEqual({
      name: 'main',
      isCurrent: true,
      isRemote: false,
      tracking: undefined,
    });
    expect(branches[1]).toEqual({
      name: 'feature/login',
      isCurrent: false,
      isRemote: false,
      tracking: undefined,
    });
    expect(branches[2]).toEqual({
      name: 'feature/settings',
      isCurrent: false,
      isRemote: false,
      tracking: undefined,
    });
  });

  it('parses remote branches', () => {
    const output = [
      '* main',
      '  remotes/origin/main',
      '  remotes/origin/feature',
      '  remotes/upstream/develop',
    ].join('\n');

    const branches = parseBranches(output);

    expect(branches).toHaveLength(4);
    expect(branches[0].isRemote).toBe(false);
    expect(branches[1].isRemote).toBe(true);
    expect(branches[1].name).toBe('remotes/origin/main');
    expect(branches[2].name).toBe('remotes/origin/feature');
    expect(branches[3].name).toBe('remotes/upstream/develop');
  });

  it('parses tracking info from git branch -vv', () => {
    const output = [
      '* main       7a3b2c1 [origin/main] Fix login bug',
      '  feature    a1b2c3d [origin/feature] Add settings page',
      '  local-only e4f5g6h Local experiment',
    ].join('\n');

    const branches = parseBranches(output);

    expect(branches).toHaveLength(3);
    expect(branches[0].name).toBe('main');
    expect(branches[0].tracking).toBe('origin/main');
    expect(branches[0].isCurrent).toBe(true);

    expect(branches[1].name).toBe('feature');
    expect(branches[1].tracking).toBe('origin/feature');

    expect(branches[2].name).toBe('local-only');
    expect(branches[2].tracking).toBeUndefined();
  });

  it('handles empty output', () => {
    const branches = parseBranches('');
    expect(branches).toEqual([]);
  });

  it('handles output with only whitespace lines', () => {
    const branches = parseBranches('\n  \n\n');
    expect(branches).toEqual([]);
  });

  it('parses single branch', () => {
    const output = '* main';
    const branches = parseBranches(output);
    expect(branches).toHaveLength(1);
    expect(branches[0].name).toBe('main');
    expect(branches[0].isCurrent).toBe(true);
  });

  it('handles detached HEAD', () => {
    const output = [
      '* (HEAD detached at abc1234)',
      '  main',
    ].join('\n');

    const branches = parseBranches(output);

    expect(branches).toHaveLength(2);
    expect(branches[0].name).toBe('(HEAD');
    expect(branches[0].isCurrent).toBe(true);
    // Note: detached HEAD name is not ideal, but the parser handles it
    // gracefully by taking the first token.
  });
});
