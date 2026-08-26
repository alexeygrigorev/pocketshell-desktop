import { beforeAll, afterAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { SshService } from '@main/ssh/SshService';
import { PocketshellClient } from '@main/helper/PocketshellClient';
import { ProjectsService } from '@main/projects/ProjectsService';
import { pathAwareCommand } from '@main/helper/bootstrap';
import { TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * The folder-first session flow against the real helper.
 *
 * Everything the unit tests assert about command SHAPE is checked here for
 * effect: that the derived name is what tmux ends up calling the session, that
 * the create is genuinely idempotent, that a quote-hostile folder name is data
 * and not code, and that a host with no `gh` still lists its local clones.
 *
 * Auto-skips when Docker is unavailable.
 */
describeDocker('ProjectsService integration', () => {
  let container: StartedTestContainer | undefined;
  let ssh: SshService;
  let projects: ProjectsService;
  let connectionId: string | undefined;

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:helper')
      .withExposedPorts(22)
      .start();
    ssh = new SshService();
    const result = await ssh.connect({
      host: container.getHost(),
      port: container.getMappedPort(22),
      user: 'testuser',
      privateKeyPath: TEST_KEY_PATH,
      knownHosts: null,
      tofuDecision: 'accept-once',
      timeoutMs: 15_000,
    });
    if (!result.ok || !result.connectionId) throw new Error('connect failed');
    connectionId = result.connectionId;
    projects = new ProjectsService(ssh, new PocketshellClient(ssh));
    await new Promise((r) => setTimeout(r, 1500));
  }, 120_000);

  afterAll(async () => {
    if (connectionId) ssh.close(connectionId);
    if (container) await container.stop();
  });

  it('resolves the remote $HOME', async () => {
    const home = await projects.home(connectionId!);
    expect(home.ok).toBe(true);
    expect(home.home).toBe('/home/testuser');
  });

  it('derives the same name for the `~` and absolute forms of a folder', async () => {
    await projects.createFolder(connectionId!, { parent: '~/git', name: 'derive-probe' });
    expect(await projects.deriveSessionName(connectionId!, '~/git/derive-probe')).toBe(
      'git-derive-probe',
    );
    expect(
      await projects.deriveSessionName(connectionId!, '/home/testuser/git/derive-probe'),
    ).toBe('git-derive-probe');
    expect(await projects.deriveSessionName(connectionId!, '~')).toBe('home-testuser');
  });

  it('creates a new empty folder and starts a session named after it', async () => {
    const folder = await projects.createFolder(connectionId!, {
      parent: '~/git',
      name: 'new-empty',
    });
    expect(folder.ok).toBe(true);
    expect(folder.path).toBe('/home/testuser/git/new-empty');

    const started = await projects.startSession(connectionId!, { folder: folder.path! });
    expect(started.ok).toBe(true);
    expect(started.sessionName).toBe('git-new-empty');
    expect(started.folder).toBe('/home/testuser/git/new-empty');

    // tmux really has it, and really has it THERE.
    const listed = await ssh.exec(
      connectionId!,
      pathAwareCommand(
        "tmux list-sessions -F '#{session_name}::#{session_path}' | grep '^git-new-empty::'",
      ),
    );
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.trim()).toBe('git-new-empty::/home/testuser/git/new-empty');
  });

  it('is idempotent: starting again in the same folder reuses the session', async () => {
    const first = await projects.startSession(connectionId!, { folder: '~/git/new-empty' });
    expect(first.ok).toBe(true);
    expect(first.reused).toBe(true);
    expect(first.sessionName).toBe('git-new-empty');

    const count = await ssh.exec(
      connectionId!,
      pathAwareCommand("tmux list-sessions -F '#{session_name}' | grep -c '^git-new-empty$'"),
    );
    expect(count.stdout.trim()).toBe('1');
  });

  it('gives a genuinely new session under the unique policy', async () => {
    const out = await projects.startSession(connectionId!, {
      folder: '~/git/new-empty',
      namePolicy: 'unique',
    });
    expect(out.ok).toBe(true);
    expect(out.sessionName).toBe('git-new-empty-2');
  });

  /**
   * The `+` -> New session bug, reproduced against a real tmux.
   *
   * The free-name walk used to ask a bare `tmux has-session`, which reaches ONE
   * tmux server. src/main/projects/sessionDirs.ts quotes the user's log where
   * raw `tmux` answered `can't find session:` for three sessions `pocketshell
   * sessions list` was listing quite happily — so "free" was being decided
   * against a socket that could not see the session already on screen. And the
   * create underneath is attach-or-create, so the "new" session came back as the
   * one the user was already looking at.
   *
   * `tmux -L` is that condition, exactly and on purpose: a second server whose
   * socket lives beside the default one in `$TMUX_TMPDIR/tmux-$(id -u)/`. The
   * assertion in the middle is the part that makes this a regression test rather
   * than a tautology — it pins that the default socket really is blind to the
   * session, which is the premise the old walk got wrong.
   */
  it('skips a name that is held on ANOTHER tmux socket', async () => {
    await projects.createFolder(connectionId!, { parent: '~/git', name: 'socket-probe' });
    const held = await ssh.exec(
      connectionId!,
      pathAwareCommand(
        'tmux -L ps-alt new-session -d -s git-socket-probe -c "$HOME/git/socket-probe"',
      ),
    );
    expect(held.exitCode).toBe(0);

    // The premise: the default server denies a session that exists.
    const blind = await ssh.exec(
      connectionId!,
      pathAwareCommand("tmux has-session -t '=git-socket-probe' 2>/dev/null"),
    );
    expect(blind.exitCode).not.toBe(0);

    const out = await projects.startSession(connectionId!, {
      folder: '~/git/socket-probe',
      namePolicy: 'unique',
    });
    expect(out.ok).toBe(true);
    // Not `git-socket-probe`, which would have attached to the session above.
    expect(out.sessionName).toBe('git-socket-probe-2');
  });

  it('refuses to start in a folder that does not exist', async () => {
    const out = await projects.startSession(connectionId!, { folder: '~/git/definitely-not-here' });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('folder-missing');
    // The helper would have exited 0 and put the pane in $HOME; nothing was created.
    const listed = await ssh.exec(
      connectionId!,
      pathAwareCommand("tmux list-sessions -F '#{session_name}' | grep -c 'definitely-not-here'"),
    );
    expect(listed.stdout.trim()).toBe('0');
  });

  it('treats a quote-hostile folder name as data, not as a command', async () => {
    // No `/` — a folder NAME containing one is rejected outright by
    // normaliseProjectFolderName, so the payload has to be slash-free to get
    // as far as the shell at all.
    const name = "wei'rd $(touch PWNED) `id` ; :";
    const folder = await projects.createFolder(connectionId!, { parent: '~/git', name });
    expect(folder.ok).toBe(true);
    expect(folder.path).toBe(`/home/testuser/git/${name}`);

    const started = await projects.startSession(connectionId!, { folder: folder.path! });
    expect(started.ok).toBe(true);
    // Every unsafe character is folded by the name derivation, so the tmux
    // session name is tame even though the folder name is not.
    expect(started.sessionName).toBe('git-wei-rd-touch-PWNED-id-_');

    // The canary: `touch PWNED` would land in the exec's cwd ($HOME) or the
    // clone root if any quoting layer had let the payload execute.
    const pwned = await ssh.exec(
      connectionId!,
      pathAwareCommand('[ -e "$HOME/PWNED" ] || [ -e "$HOME/git/PWNED" ]'),
    );
    expect(pwned.exitCode).not.toBe(0);
  });

  it('lists local clones and reports the absent gh rather than failing', async () => {
    // Seed a clone so the local scan has something to find.
    await ssh.exec(
      connectionId!,
      pathAwareCommand(
        'mkdir -p "$HOME/git/repo-probe" && cd "$HOME/git/repo-probe" && git init -q && ' +
          'git config user.email t@t && git config user.name t && ' +
          'echo hi > README.md && git add -A && git commit -qm init',
      ),
    );
    const out = await projects.reposList(connectionId!);
    // gh is absent on this image — a normal host state, so the call still
    // succeeds and the local list is intact.
    expect(out.ok).toBe(true);
    expect(out.remote?.state).toBe('gh-missing');
    expect(out.remote?.repos).toEqual([]);
    expect(out.local?.state).toBe('ok');
    expect(out.repos.map((r) => r.name)).toContain('repo-probe');
    const probe = out.repos.find((r) => r.name === 'repo-probe')!;
    expect(probe.local?.path).toBe('/home/testuser/git/repo-probe');
    // No GitHub origin -> no owner/fullName; consumers must fall back to name.
    expect(probe.fullName).toBeNull();
  });

  it('scopes the local scan to an explicit root', async () => {
    const out = await projects.reposList(connectionId!, {
      scope: 'local',
      roots: ['~/does-not-exist'],
    });
    // A missing scan root warns on stderr but still exits 0 with `[]`.
    expect(out.local?.state).toBe('ok');
    expect(out.repos).toEqual([]);
  });
});
