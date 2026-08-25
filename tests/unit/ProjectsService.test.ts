import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExecResult } from '../../src/shared/types.js';
import type { SshService } from '@main/ssh/SshService';
import { PocketshellClient } from '@main/helper/PocketshellClient';
import { ProjectsService, type CloneProgress } from '@main/projects/ProjectsService';

const FIXTURES = resolve(__dirname, 'fixtures');
const readFixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

const CONN = 'conn-1';
const HOME = '/home/testuser';

/** A recorded exec: what the host was asked, and what it answered. */
type Responder = (command: string) => ExecResult | null;

/**
 * Strip the `pathAwareCommand` wrapper so an assertion can read the command
 * that was actually built.
 *
 * Every exec goes out as `/bin/sh -lc 'export PATH="…"; <command>'` (sshd runs
 * a non-login shell, so `$HOME/.local/bin` — where uv puts `pocketshell` and
 * `tmuxctl` — is not on PATH otherwise). That wrapper re-escapes the inner
 * command's own quotes, which is exactly the layering these tests want to see
 * survive; unwrapping it here keeps the expectations readable while still
 * exercising the real, doubly-quoted string.
 */
function inner(command: string): string {
  const match = /^\/bin\/sh -lc '(.*)'$/s.exec(command);
  if (!match) return command;
  return match[1]!.replace(/'\\''/g, "'").replace(/^export PATH="[^"]*"; /, '');
}

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (exitCode: number, stderr = '', stdout = ''): ExecResult => ({
  stdout,
  stderr,
  exitCode,
});

/**
 * A fake SshService that answers by matching the command text.
 *
 * Matching on the command is the point: these tests assert on WHAT is sent to
 * the host as much as on what comes back, so a change to the wire form of a
 * command shows up here rather than only on a live box.
 */
function fakeSsh(responders: Responder[]): { ssh: SshService; commands: string[] } {
  const commands: string[] = [];
  const ssh = {
    exec: (_connectionId: string, command: string): Promise<ExecResult> => {
      commands.push(command);
      for (const responder of responders) {
        const answer = responder(command);
        if (answer) return Promise.resolve(answer);
      }
      return Promise.resolve(fail(127, 'sh: not found'));
    },
  } as unknown as SshService;
  return { ssh, commands };
}

const homeResponder: Responder = (c) => (c.includes('printf %s "$HOME"') ? ok(HOME) : null);
const dirExistsResponder: Responder = (c) => (c.includes('[ -d ') ? ok() : null);
const pwdResponder: Responder = (c) => (c.includes('pwd -P') ? ok(`${HOME}/git/x\n`) : null);
const noSessionResponder: Responder = (c) => (c.includes('has-session') ? fail(1) : null);

function service(responders: Responder[]): {
  projects: ProjectsService;
  commands: string[];
} {
  const { ssh, commands } = fakeSsh(responders);
  return { projects: new ProjectsService(ssh, new PocketshellClient(ssh)), commands };
}

describe('ProjectsService.home', () => {
  it('resolves and caches $HOME', async () => {
    const { projects, commands } = service([homeResponder]);
    expect(await projects.home(CONN)).toEqual({ ok: true, home: HOME, error: null });
    await projects.home(CONN);
    // Cached: one exec for two calls. $HOME cannot change under a connection.
    expect(commands.filter((c) => c.includes('$HOME"')).length).toBe(1);
  });

  it('reports failure rather than inventing a home', async () => {
    const { projects } = service([(c) => (c.includes('$HOME') ? fail(1, 'nope') : null)]);
    const out = await projects.home(CONN);
    expect(out).toEqual({ ok: false, home: null, error: 'nope' });
  });

  it('drops the cache on evict', async () => {
    const { projects, commands } = service([homeResponder]);
    await projects.home(CONN);
    projects.evict(CONN);
    await projects.home(CONN);
    expect(commands.filter((c) => c.includes('$HOME"')).length).toBe(2);
  });
});

describe('ProjectsService.deriveSessionName', () => {
  it('derives the phone-compatible name from the folder', async () => {
    const { projects } = service([homeResponder]);
    expect(await projects.deriveSessionName(CONN, `${HOME}/git/pocketshell`)).toBe(
      'git-pocketshell',
    );
    expect(await projects.deriveSessionName(CONN, '~/git/pocketshell')).toBe('git-pocketshell');
    expect(await projects.deriveSessionName(CONN, HOME)).toBe('home-testuser');
  });

  it('honours a custom label', async () => {
    const { projects } = service([homeResponder]);
    expect(await projects.deriveSessionName(CONN, `${HOME}/git/x`, 'My Label')).toBe('My-Label');
  });
});

describe('ProjectsService.startSession', () => {
  const createResponder: Responder = (c) =>
    c.includes('sessions create') ? ok('git-x\n') : null;

  it('runs the folder pre-flight, derives the name, and passes --cwd but not --mem', async () => {
    const { projects, commands } = service([
      homeResponder,
      dirExistsResponder,
      pwdResponder,
      noSessionResponder,
      createResponder,
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x' });
    expect(out).toEqual({
      ok: true,
      sessionName: 'git-x',
      folder: `${HOME}/git/x`,
      reused: false,
      via: 'helper',
      error: null,
      code: null,
    });
    const create = inner(commands.find((c) => c.includes('sessions create'))!);
    expect(create).toContain("sessions create 'git-x'");
    expect(create).toContain(`-c '${HOME}/git/x'`);
    expect(create).not.toContain('--mem');
  });

  it('refuses a folder that does not exist instead of creating a misplaced session', async () => {
    // The helper itself exits 0 for a missing --cwd and lands the pane in
    // $HOME, so this guard is the only thing between the user and a session
    // that claims to be somewhere it is not.
    const { projects, commands } = service([
      homeResponder,
      (c) => (c.includes('[ -d ') ? fail(1) : null),
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/typo' });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('folder-missing');
    expect(out.error).toContain('~/git/typo');
    expect(commands.some((c) => c.includes('sessions create'))).toBe(false);
  });

  it('reports reuse when the folder already has a session (idempotent, no second create)', async () => {
    const { projects, commands } = service([
      homeResponder,
      dirExistsResponder,
      pwdResponder,
      (c) => (c.includes('has-session') ? ok() : null),
      createResponder,
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x' });
    expect(out.ok).toBe(true);
    expect(out.reused).toBe(true);
    expect(out.sessionName).toBe('git-x');
    expect(commands.filter((c) => c.includes('sessions create'))).toHaveLength(1);
  });

  it('asks the HOST for a free name under the unique policy', async () => {
    const { projects, commands } = service([
      homeResponder,
      dirExistsResponder,
      pwdResponder,
      (c) => (c.includes('__ps_n=') ? ok('git-x-2\n') : null),
      (c) => (c.includes('sessions create') ? ok('git-x-2\n') : null),
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x', namePolicy: 'unique' });
    expect(out.sessionName).toBe('git-x-2');
    expect(commands.map(inner).some((c) => c.includes("__ps_n='git-x'"))).toBe(true);
    expect(inner(commands.find((c) => c.includes('sessions create'))!)).toContain("'git-x-2'");
  });

  it('falls back to the base name when the free-name probe fails — never blocks a create', async () => {
    const { projects } = service([
      homeResponder,
      dirExistsResponder,
      pwdResponder,
      (c) => (c.includes('__ps_n=') ? fail(1) : null),
      createResponder,
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x', namePolicy: 'unique' });
    expect(out.ok).toBe(true);
    expect(out.sessionName).toBe('git-x');
  });

  it('uses the raw tmux create when the helper is absent', async () => {
    const { projects, commands } = service([
      homeResponder,
      dirExistsResponder,
      pwdResponder,
      noSessionResponder,
      (c) => (c.includes('sessions create') ? fail(127, 'sh: pocketshell: not found') : null),
      (c) => (c.includes('new-session') ? ok() : null),
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x' });
    expect(out.ok).toBe(true);
    expect(out.via).toBe('tmux-fallback');
    expect(commands.map(inner).some((c) => c.includes("tmux new-session -A -d -s 'git-x'"))).toBe(
      true,
    );
  });

  it('surfaces a GENUINE create failure instead of downgrading to the uncapped fallback', async () => {
    const { projects, commands } = service([
      homeResponder,
      dirExistsResponder,
      pwdResponder,
      noSessionResponder,
      (c) => (c.includes('sessions create') ? fail(1, 'tmuxctl: systemd-run refused') : null),
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x' });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('create-failed');
    expect(out.error).toBe('tmuxctl: systemd-run refused');
    expect(commands.some((c) => c.includes('new-session'))).toBe(false);
  });

  it('takes the name the host echoes back over the one it asked for', async () => {
    const { projects } = service([
      homeResponder,
      dirExistsResponder,
      pwdResponder,
      noSessionResponder,
      (c) => (c.includes('sessions create') ? ok('git-x-7\n') : null),
    ]);
    expect((await projects.startSession(CONN, { folder: '~/git/x' })).sessionName).toBe('git-x-7');
  });
});

describe('ProjectsService.createFolder', () => {
  it('creates the folder and returns its canonical path', async () => {
    const { projects, commands } = service([
      (c) => (c.includes('mkdir -p --') ? ok() : null),
      (c) => (c.includes('pwd -P') ? ok(`${HOME}/git/new-thing`) : null),
    ]);
    const out = await projects.createFolder(CONN, { parent: '~/git', name: ' new-thing ' });
    expect(out).toEqual({ ok: true, path: `${HOME}/git/new-thing`, error: null });
    expect(inner(commands[0]!)).toBe("mkdir -p -- $HOME/'git/new-thing'");
  });

  it('rejects a name that is not a single folder', async () => {
    const { projects, commands } = service([]);
    for (const name of ['', '..', 'a/b', 'a\\b']) {
      const out = await projects.createFolder(CONN, { parent: '~/git', name });
      expect(out.ok).toBe(false);
      expect(out.path).toBeNull();
    }
    expect(commands).toEqual([]);
  });

  it('quotes a hostile folder name rather than executing it', async () => {
    const { projects, commands } = service([
      (c) => (c.includes('mkdir') ? ok() : null),
      (c) => (c.includes('pwd -P') ? ok(`${HOME}/git/x`) : null),
    ]);
    // No `/` in the NAME — that is rejected outright by the validator above —
    // so the payload rides in on the parent path and on a slash-free name.
    await projects.createFolder(CONN, {
      parent: "~/git/wei'rd $(touch PWNED)",
      name: "a'; touch PWNED; :",
    });
    // The payload never leaves its quoted region, through BOTH quoting layers:
    // the command builder's, and pathAwareCommand's re-escape on top of it.
    expect(inner(commands[0]!)).toBe(
      "mkdir -p -- $HOME/'git/wei'\\''rd $(touch PWNED)/a'\\''; touch PWNED; :'",
    );
    // The `$(…)` and the `;` are present as DATA, never as syntax.
    expect(commands[0]).toContain('touch PWNED');
    expect((commands[0]!.replace(/\\'/g, '').match(/'/g)?.length ?? 0) % 2).toBe(0);
  });

  it('reports the host message when mkdir fails', async () => {
    const { projects } = service([(c) => (c.includes('mkdir') ? fail(1, 'Permission denied') : null)]);
    const out = await projects.createFolder(CONN, { parent: '/root', name: 'x' });
    expect(out).toEqual({ ok: false, path: null, error: 'Permission denied' });
  });
});

describe('ProjectsService.reposList', () => {
  const localOk: Responder = (c) =>
    c.includes('repos list --local') ? ok(readFixture('v0.4.44-repos-list-local.json')) : null;
  const ghMissing: Responder = (c) =>
    c.includes('repos list --remote')
      ? fail(127, readFixture('v0.4.44-repos-list-remote-gh-missing.stderr.txt'))
      : null;

  it('runs both scopes and merges them', async () => {
    const { projects } = service([
      localOk,
      (c) =>
        c.includes('repos list --remote')
          ? ok(readFixture('v0.4.44-repos-list-remote-schema.json'))
          : null,
    ]);
    const out = await projects.reposList(CONN);
    expect(out.ok).toBe(true);
    expect(out.local?.state).toBe('ok');
    expect(out.remote?.state).toBe('ok');
    expect(out.repos.map((r) => r.name)).toEqual([
      'demo-repo',
      'Hello-World',
      'pocketshell',
      'dataops',
    ]);
  });

  it('stays ok when the host has no gh — the local list is what matters', async () => {
    const { projects } = service([localOk, ghMissing]);
    const out = await projects.reposList(CONN);
    expect(out.ok).toBe(true);
    expect(out.remote?.state).toBe('gh-missing');
    expect(out.remote?.repos).toEqual([]);
    expect(out.remote?.error).toContain('`gh` is not installed');
    expect(out.repos).toHaveLength(2);
  });

  it('runs only the requested scope', async () => {
    const { projects, commands } = service([localOk]);
    const out = await projects.reposList(CONN, { scope: 'local' });
    expect(out.remote).toBeNull();
    expect(commands.some((c) => c.includes('--remote'))).toBe(false);
  });

  it('clears ok for a genuine scope failure', async () => {
    const { projects } = service([
      (c) => (c.includes('--local') ? fail(1, 'boom') : null),
      ghMissing,
    ]);
    const out = await projects.reposList(CONN);
    expect(out.ok).toBe(false);
    expect(out.local?.state).toBe('failed');
  });
});

describe('ProjectsService.cloneRepo', () => {
  it('emits started/finished around the clone and returns the path', async () => {
    const { projects } = service([
      (c) => (c.includes('repos clone') ? ok('/home/testuser/git/Hello-World\n') : null),
    ]);
    const events: CloneProgress[] = [];
    const out = await projects.cloneRepo(
      CONN,
      { repository: 'octocat/Hello-World', requestId: 'r1' },
      (p) => events.push(p),
    );
    expect(out).toEqual({
      ok: true,
      path: '/home/testuser/git/Hello-World',
      alreadyExists: false,
      error: null,
    });
    expect(events.map((e) => e.phase)).toEqual(['started', 'finished']);
    expect(events[0]!.requestId).toBe('r1');
    expect(events[1]!.path).toBe('/home/testuser/git/Hello-World');
  });

  it('recovers the path from the "already exists" failure so the flow can continue', async () => {
    // Real stderr, exit 1, from re-cloning on the fixture.
    const { projects } = service([
      (c) =>
        c.includes('repos clone')
          ? fail(1, readFixture('v0.4.44-repos-clone-exists.stderr.txt'))
          : null,
    ]);
    const out = await projects.cloneRepo(CONN, { repository: 'octocat/Hello-World' });
    expect(out).toEqual({
      ok: true,
      path: '/home/testuser/git/Hello-World',
      alreadyExists: true,
      error: null,
    });
  });

  it('reports a git failure with the host message', async () => {
    const { projects } = service([
      (c) =>
        c.includes('repos clone')
          ? fail(128, readFixture('v0.4.44-repos-clone-failed.stderr.txt'))
          : null,
    ]);
    const out = await projects.cloneRepo(CONN, { repository: 'nosuchowner/nosuchrepo-xyz' });
    expect(out.ok).toBe(false);
    expect(out.path).toBeNull();
    expect(out.error).toContain('could not read Username');
  });

  it('still emits finished when the clone fails, so the UI stops spinning', async () => {
    const { projects } = service([(c) => (c.includes('repos clone') ? fail(128, 'nope') : null)]);
    const events: CloneProgress[] = [];
    await projects.cloneRepo(CONN, { repository: 'o/r', requestId: 'r2' }, (p) => events.push(p));
    expect(events.map((e) => e.phase)).toEqual(['started', 'finished']);
    expect(events[1]!.error).toBe('nope');
  });
});

describe('PocketshellClient.createSession — real fixture output', () => {
  it('reads the resolved name off stdout and ignores the tmuxctl stderr notice', async () => {
    // Captured from `pocketshell sessions create fixture-probe-2 -c $HOME`
    // on the Docker fixture (helper 0.4.44): the name on stdout, a
    // "systemd-run unavailable; session runs without a memory cap" notice on
    // stderr, exit 0.
    const { ssh } = fakeSsh([
      (c) =>
        c.includes('sessions create')
          ? {
              stdout: readFixture('v0.4.44-sessions-create.stdout.txt'),
              stderr: readFixture('v0.4.44-sessions-create.stderr.txt'),
              exitCode: 0,
            }
          : null,
    ]);
    const out = await new PocketshellClient(ssh).createSession(CONN, {
      name: 'fixture-probe-2',
      cwd: '$HOME',
    });
    expect(out).toEqual({ ok: true, name: 'fixture-probe-2', via: 'helper', error: null });
  });

  it('falls back to raw tmux when the helper binary is absent', async () => {
    // The one case the fallback still exists for: no `pocketshell` on PATH.
    // The session comes up WITHOUT a memory cap, which is why `via` has to say
    // `tmux-fallback` — the dialog turns that into a sentence for the user.
    const { ssh, commands } = fakeSsh([
      (c) => (c.includes('sessions create') ? fail(127, 'sh: pocketshell: not found') : null),
      (c) => (c.includes('tmux new-session') ? ok('') : null),
    ]);
    const out = await new PocketshellClient(ssh).createSession(CONN, {
      name: 's',
      cwd: '/home/testuser/git/x',
    });
    expect(out).toEqual({ ok: true, name: 's', via: 'tmux-fallback', error: null });
    expect(commands.some((c) => inner(c).includes('tmux new-session -A -d'))).toBe(true);
  });

  it('does NOT fall back when the helper rejects the command — that would drop the memory cap', async () => {
    // Click exits 2 with "No such command" for a subcommand the installed
    // helper does not have. That used to trigger this fallback as an
    // old-helper shim, which meant a command WE got wrong was laundered into a
    // successful-looking, uncapped session. Against 0.4.44 it is a real fault,
    // so it must fail loudly and never reach raw tmux.
    const { ssh, commands } = fakeSsh([
      (c) => (c.includes('sessions create') ? fail(2, "Error: No such command 'sessions'.") : null),
      (c) => (c.includes('tmux new-session') ? ok('') : null),
    ]);
    const out = await new PocketshellClient(ssh).createSession(CONN, {
      name: 's',
      cwd: '/home/testuser/git/x',
    });
    expect(out.ok).toBe(false);
    expect(out.via).toBe('helper');
    expect(out.error).toContain("No such command 'sessions'.");
    expect(out.error).toContain('pocketshell --version');
    expect(commands.some((c) => c.includes('tmux new-session'))).toBe(false);
  });

  it('reports a rejected option instead of quietly creating an uncapped session', async () => {
    const { ssh, commands } = fakeSsh([
      (c) => (c.includes('sessions create') ? fail(2, 'Error: No such option: --cwd') : null),
      (c) => (c.includes('tmux new-session') ? ok('') : null),
    ]);
    const out = await new PocketshellClient(ssh).createSession(CONN, {
      name: 's',
      cwd: '/home/testuser/git/x',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('drifted');
    expect(commands.some((c) => c.includes('tmux new-session'))).toBe(false);
  });
});

/**
 * docs/WORKSPACE.md §4. The session name is the JOIN KEY — `sessionAttachCommand`
 * builds `tmuxctl '<name>'` with no fallback behind it — so a rename that
 * produces an unjoinable or duplicate name would strand a live session. These
 * pin the two guards that make that impossible.
 */
describe('ProjectsService.renameSession', () => {
  it('renames with an exact-match target and an option terminator', async () => {
    const { projects, commands } = service([
      noSessionResponder,
      (c) => (c.includes('rename-session') ? ok() : null),
    ]);
    const out = await projects.renameSession(CONN, 'git-x', 'git-x-staging');
    expect(out).toEqual({ ok: true, sessionName: 'git-x-staging', error: null, code: null });
    expect(commands.map(inner)).toContain(
      "tmux rename-session -t '=git-x' -- 'git-x-staging'",
    );
  });

  it('sanitises to the alphabet `tmuxctl <name>` can still join', async () => {
    const { projects, commands } = service([
      noSessionResponder,
      (c) => (c.includes('rename-session') ? ok() : null),
    ]);
    const out = await projects.renameSession(CONN, 'git-x', 'feat/my.branch');
    expect(out.sessionName).toBe('feat-my_branch');
    expect(commands.map(inner).join('\n')).toContain("-- 'feat-my_branch'");
  });

  it('asks the HOST whether the name is free, and refuses when it is not', async () => {
    const { projects, commands } = service([(c) => (c.includes('has-session') ? ok() : null)]);
    const out = await projects.renameSession(CONN, 'git-x', 'git-y');
    expect(out).toMatchObject({ ok: false, code: 'name-taken' });
    // The exact-match `=` is what stops `git-y` probing as taken because
    // `git-y-2` exists.
    expect(commands.map(inner)).toContain("tmux has-session -t '=git-y' 2>/dev/null");
    expect(commands.some((c) => c.includes('rename-session'))).toBe(false);
  });

  it('refuses a name with nothing alphanumeric left rather than inventing one', async () => {
    const { projects, commands } = service([]);
    const out = await projects.renameSession(CONN, 'git-x', ':::');
    expect(out).toMatchObject({ ok: false, code: 'illegal-name' });
    expect(commands).toEqual([]);
  });

  it('treats an unchanged name as a success, and never probes for it', async () => {
    // Committing an unchanged tab label is the commonest thing a rename field
    // does; probing would find the session itself and report its own name taken.
    const { projects, commands } = service([]);
    expect(await projects.renameSession(CONN, 'git-x', 'git-x')).toMatchObject({
      ok: true,
      sessionName: 'git-x',
    });
    expect(commands).toEqual([]);
  });

  it("surfaces tmux's own stderr when the rename fails", async () => {
    const { projects } = service([
      noSessionResponder,
      (c) => (c.includes('rename-session') ? fail(1, "can't find session: git-x") : null),
    ]);
    const out = await projects.renameSession(CONN, 'git-x', 'git-y');
    expect(out).toMatchObject({ ok: false, code: 'rename-failed' });
    expect(out.error).toContain("can't find session");
  });
});
