import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyReposFailure,
  isHelperMissing,
  mergeRepos,
  parseReposJson,
} from '@main/projects/repos';

/**
 * Captured verbatim from the Docker fixture (`tests-docker` helper service,
 * port 3205) running pocketshell 0.4.8 — nothing here is hand-authored except
 * the `--remote` payload, which the fixture cannot produce because the image
 * ships no `gh`. That one is copied from the schema block in the helper's own
 * `pocketshell/repos.py` module docstring, read off the same container.
 */
const FIXTURES = resolve(__dirname, 'fixtures');
const readFixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

describe('parseReposJson — real `repos list --local --json` output', () => {
  const rows = parseReposJson(readFixture('v0.4.8-repos-list-local.json'));

  it('parses every row', () => {
    expect(rows).toHaveLength(2);
  });

  it('carries a populated local block and a null remote block', () => {
    expect(rows[0]).toEqual({
      name: 'demo-repo',
      owner: null,
      fullName: null,
      local: { path: '/home/testuser/git/demo-repo', head: 'master' },
      remote: null,
    });
  });

  it('leaves owner/fullName null for a clone with no GitHub origin', () => {
    // A plain `git init` folder: the helper cannot infer owner/full_name, so a
    // consumer keying on fullName must fall back to name.
    expect(rows[0]!.fullName).toBeNull();
    expect(rows[0]!.owner).toBeNull();
  });

  it('populates owner/fullName from a GitHub origin', () => {
    expect(rows[1]!.owner).toBe('octocat');
    expect(rows[1]!.fullName).toBe('octocat/Hello-World');
    expect(rows[1]!.local?.path).toBe('/home/testuser/git/Hello-World');
  });
});

describe('parseReposJson — `--remote` schema', () => {
  const rows = parseReposJson(readFixture('v0.4.8-repos-list-remote-schema.json'));

  it('carries a populated remote block and a null local block', () => {
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: 'pocketshell',
      owner: 'alexeygrigorev',
      fullName: 'alexeygrigorev/pocketshell',
      local: null,
      remote: {
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/alexeygrigorev/pocketshell',
        sshUrl: 'git@github.com:alexeygrigorev/pocketshell.git',
        updatedAt: '2026-05-27T12:00:00Z',
      },
    });
  });
});

describe('parseReposJson — degradation', () => {
  it('returns [] for blank, non-JSON, or non-array payloads', () => {
    expect(parseReposJson('')).toEqual([]);
    expect(parseReposJson('   ')).toEqual([]);
    expect(parseReposJson('not json')).toEqual([]);
    expect(parseReposJson('{"profiles":[]}')).toEqual([]);
  });

  it('drops rows it cannot identify rather than throwing', () => {
    expect(parseReposJson('[null, 3, {}, {"name":"ok"}]')).toEqual([
      { name: 'ok', owner: null, fullName: null, local: null, remote: null },
    ]);
  });

  it('recovers a name from the clone path when `name` is missing', () => {
    const rows = parseReposJson('[{"local":{"path":"/home/a/git/thing","head":null}}]');
    expect(rows[0]!.name).toBe('thing');
    expect(rows[0]!.local?.head).toBeNull();
  });

  it('synthesises fullName from owner + name when the helper omits it', () => {
    const rows = parseReposJson('[{"name":"r","owner":"o"}]');
    expect(rows[0]!.fullName).toBe('o/r');
  });
});

describe('mergeRepos', () => {
  const local = parseReposJson(readFixture('v0.4.8-repos-list-local.json'));
  const remote = parseReposJson(readFixture('v0.4.8-repos-list-remote-schema.json'));

  it('joins a cloned repo and its GitHub row into ONE entry carrying both blocks', () => {
    const merged = mergeRepos(local, [
      {
        name: 'Hello-World',
        owner: 'octocat',
        fullName: 'octocat/Hello-World',
        local: null,
        remote: { defaultBranch: 'master', htmlUrl: null, sshUrl: null, updatedAt: null },
      },
    ]);
    expect(merged).toHaveLength(2);
    const joined = merged.find((r) => r.fullName === 'octocat/Hello-World')!;
    expect(joined.local?.path).toBe('/home/testuser/git/Hello-World');
    expect(joined.remote?.defaultBranch).toBe('master');
  });

  it('appends remote-only rows after the local ones', () => {
    const merged = mergeRepos(local, remote);
    expect(merged.map((r) => r.name)).toEqual([
      'demo-repo',
      'Hello-World',
      'pocketshell',
      'dataops',
    ]);
  });

  it('keys on name when fullName is null on both sides', () => {
    const merged = mergeRepos(
      [{ name: 'x', owner: null, fullName: null, local: { path: '/a/x', head: null }, remote: null }],
      [{ name: 'x', owner: null, fullName: null, local: null, remote: null }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.local?.path).toBe('/a/x');
  });

  it('handles either side being empty', () => {
    expect(mergeRepos([], [])).toEqual([]);
    expect(mergeRepos(local, [])).toHaveLength(2);
    expect(mergeRepos([], remote)).toHaveLength(2);
  });
});

describe('classifyReposFailure', () => {
  it('reports a missing `gh` as gh-missing, not as a broken helper', () => {
    // Real stderr, exit 127, from `repos list --remote --json` on the fixture.
    const stderr = readFixture('v0.4.8-repos-list-remote-gh-missing.stderr.txt');
    const out = classifyReposFailure(127, '', stderr);
    expect(out.state).toBe('gh-missing');
    expect(out.error).toContain('`gh` is not installed on this host');
  });

  it('does not let the gh-missing message read as gh-unauthenticated', () => {
    // The gh-missing text mentions `gh auth login`, which is also the
    // unauthenticated marker — the "is not installed" check has to win.
    const stderr = readFixture('v0.4.8-repos-list-remote-gh-missing.stderr.txt');
    expect(stderr).toContain('gh auth login');
    expect(classifyReposFailure(127, '', stderr).state).toBe('gh-missing');
  });

  it('reports a logged-out gh as gh-unauthenticated', () => {
    expect(classifyReposFailure(1, '', 'gh: not authenticated. Run gh auth login.').state).toBe(
      'gh-unauthenticated',
    );
    expect(classifyReposFailure(4, '', 'authentication required').state).toBe(
      'gh-unauthenticated',
    );
  });

  it('reports an absent helper as helper-missing', () => {
    expect(classifyReposFailure(127, '', 'sh: pocketshell: not found').state).toBe(
      'helper-missing',
    );
    expect(classifyReposFailure(2, '', "Error: No such command 'repos'.").state).toBe(
      'helper-missing',
    );
  });

  it('reports anything else as a plain failure, keeping the host message', () => {
    const out = classifyReposFailure(1, '', 'boom');
    expect(out.state).toBe('failed');
    expect(out.error).toBe('boom');
  });

  it('falls back to stdout, then to the exit code, for the message', () => {
    expect(classifyReposFailure(1, 'on stdout', '').error).toBe('on stdout');
    expect(classifyReposFailure(9, '', '').error).toBe('pocketshell repos exited 9');
  });
});

describe('isHelperMissing', () => {
  it('is true for the shell 127 and for an unknown subcommand', () => {
    expect(isHelperMissing(127, 'sh: pocketshell: not found')).toBe(true);
    expect(isHelperMissing(127, '/bin/sh: 1: pocketshell: command not found')).toBe(true);
    expect(isHelperMissing(2, "Error: No such command 'sessions'.")).toBe(true);
    expect(isHelperMissing(2, "Error: No such option: --cwd")).toBe(true);
  });

  it('is false for the gh 127, which is a different absence entirely', () => {
    expect(
      isHelperMissing(127, readFixture('v0.4.8-repos-list-remote-gh-missing.stderr.txt')),
    ).toBe(false);
  });

  it('is false for a genuine runtime failure — never downgrade one silently', () => {
    expect(isHelperMissing(1, 'tmuxctl: failed to start session')).toBe(false);
    expect(isHelperMissing(3, 'session is live')).toBe(false);
  });
});
