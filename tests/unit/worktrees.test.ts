import { describe, expect, it } from 'vitest';
import { parseWorktreeRoots, repoRootFromCommonDir } from '@main/projects/worktrees';
import { gitRepoProbeCommand } from '@main/projects/commands';

/**
 * docs/WORKSPACE.md §6.5 — a git worktree groups under the repository it is a
 * worktree of.
 *
 * The behaviour these pin was verified against git 2.53: at a repository ROOT
 * and in any SUBDIRECTORY of one, `--git-dir` and `--git-common-dir` are equal;
 * in a linked worktree they differ, and the common dir points at the main
 * repository's `.git`. The host does that comparison itself and prints a line
 * only for a worktree, so what arrives here is already filtered.
 */

describe('repoRootFromCommonDir', () => {
  it('is the parent of the .git directory', () => {
    expect(repoRootFromCommonDir('/home/a/git/repo/.git')).toBe('/home/a/git/repo');
  });

  it('tolerates a trailing slash', () => {
    expect(repoRootFromCommonDir('/home/a/git/repo/.git/')).toBe('/home/a/git/repo');
  });

  it('leaves a BARE repository alone — it has no working tree above it', () => {
    expect(repoRootFromCommonDir('/srv/git/thing.git')).toBe('/srv/git/thing.git');
  });
});

describe('parseWorktreeRoots', () => {
  const REQUESTED = [
    '/home/alexey/git/merry-sniffing-token',
    '/home/alexey/git/dtc-website',
    '/home/alexey/git/plain',
  ];

  it('maps a worktree to its main repository root', () => {
    // The case the user reported: a session in `merry-sniffing-token`, which is
    // a worktree of dtc-website, named `git-dtc-website-decisions`.
    const map = parseWorktreeRoots('0::/home/alexey/git/dtc-website/.git\n', REQUESTED);
    expect(map.get('/home/alexey/git/merry-sniffing-token')).toBe('/home/alexey/git/dtc-website');
    expect(map.size).toBe(1);
  });

  it('leaves every directory the host said nothing about alone', () => {
    // A plain clone, a subdirectory of a repo, a non-repo, a host with no git:
    // the probe prints no line for any of them, and all four mean the same
    // thing here — group by your own path.
    expect(parseWorktreeRoots('', REQUESTED).size).toBe(0);
  });

  it('recovers a repo root containing the field delimiter', () => {
    // The reason the wire format carries an INDEX and one trailing path: a
    // directory may contain `::`, and if it does then so do the git answers,
    // because they are paths inside it. Splitting on the FIRST delimiter is
    // what makes the tail recoverable whatever it holds.
    const map = parseWorktreeRoots('0::/home/a/od::d/.git\n', ['/home/a/wt']);
    expect(map.get('/home/a/wt')).toBe('/home/a/od::d');
  });

  it('drops an index that is out of range rather than guessing', () => {
    // Out of step with the request can only mean the two have desynchronised,
    // and a guess would file a session under a repository chosen at random.
    expect(parseWorktreeRoots('9::/home/a/repo/.git\n', REQUESTED).size).toBe(0);
  });

  it('drops a line whose index is not purely digits', () => {
    // `Number.parseInt` would read `0abc` as 0, so a stray log line beginning
    // with a digit must not be read as a row.
    expect(parseWorktreeRoots('0abc::/home/a/repo/.git\n', REQUESTED).size).toBe(0);
  });

  it('ignores blank lines and banner noise', () => {
    const map = parseWorktreeRoots(
      'warning: detached HEAD\n\n0::/home/alexey/git/dtc-website/.git\n',
      REQUESTED,
    );
    expect(map.size).toBe(1);
  });

  it('drops a mapping that would point a directory at itself', () => {
    expect(parseWorktreeRoots('1::/home/alexey/git/dtc-website/.git\n', REQUESTED).size).toBe(0);
  });
});

describe('gitRepoProbeCommand', () => {
  it('asks for both git dirs, so a subdirectory can be told from a worktree', () => {
    const cmd = gitRepoProbeCommand(['/home/a/git/x']);
    expect(cmd).toContain('git rev-parse --git-dir');
    expect(cmd).toContain('git rev-parse --git-common-dir');
  });

  it('compares them on the HOST and stays silent for a non-worktree', () => {
    expect(gitRepoProbeCommand(['/a'])).toContain('[ "$__ps_ga" != "$__ps_ca" ] || continue');
  });

  it('resolves by cd-ing to the answer, so no --path-format flag is needed', () => {
    // `--path-format=absolute` needs git 2.31+; `cd`-ing from the directory
    // handles the absolute and the relative form identically on any git.
    const cmd = gitRepoProbeCommand(['/home/a/git/x']);
    expect(cmd).not.toContain('--path-format');
    expect(cmd).toContain('pwd -P');
  });

  it('prints the request index, not the directory path', () => {
    const cmd = gitRepoProbeCommand(['/a']);
    expect(cmd).toContain('printf \'%s::%s\\n\' "$__ps_n" "$__ps_ca"');
  });

  it('batches every directory into ONE command', () => {
    const cmd = gitRepoProbeCommand(['/a', '/b', '/c']);
    expect(cmd.match(/git rev-parse --git-dir/g)).toHaveLength(1);
    expect(cmd).toContain("for __ps_d in '/a' '/b' '/c'");
  });

  it('quotes the directories — they come from tmux, not from us', () => {
    const cmd = gitRepoProbeCommand(["/home/a/o'; touch /tmp/PWNED; :"]);
    expect(cmd).toContain("'/home/a/o'\\''; touch /tmp/PWNED; :'");
  });
});
