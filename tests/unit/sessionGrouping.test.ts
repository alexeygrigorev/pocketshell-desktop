import { describe, it, expect } from 'vitest';
import {
  UNTRACKED_LABEL,
  UNTRACKED_PATH,
  canonicalisePath,
  defaultLabelForPath,
  OTHER_LABEL,
  OTHER_ROOT,
  directoryKey,
  groupSessionsByFolder,
  groupSessionsIntoRoots,
  inferHome,
  isAgentSession,
  rootForPath,
  rootFromSessionName,
  type SessionRootFolder,
} from '../../src/renderer/sessionGrouping';
import type { SessionAgentKind, SessionSummary } from '../../src/shared/types';

/** Terse SessionSummary factory — only the fields grouping cares about. */
function session(
  name: string,
  path: string | null,
  activity: number,
  attached = false,
): SessionSummary {
  return { name, created: activity, activity, attached, path };
}

/** Same, plus the host-recorded agent kind. */
function agentSession(
  name: string,
  path: string | null,
  activity: number,
  agentKind: SessionAgentKind | null,
): SessionSummary {
  return { name, created: activity, activity, attached: false, path, agentKind };
}

describe('isAgentSession (FolderTreeProjection.kt:588)', () => {
  it('counts every launched engine, plus the transient detector states', () => {
    for (const k of ['claude', 'codex', 'opencode', 'grok', 'probing', 'exited'] as const) {
      expect(isAgentSession(k)).toBe(true);
    }
  });

  it('groups shells, unknown and absent kinds together as non-agents (#821)', () => {
    expect(isAgentSession('shell')).toBe(false);
    expect(isAgentSession('unknown')).toBe(false);
    expect(isAgentSession(null)).toBe(false);
    expect(isAgentSession(undefined)).toBe(false);
  });
});

describe('within-folder order: agents first (recencySessionSort)', () => {
  it('sorts an agent session ahead of a more recent shell', () => {
    const folders = groupSessionsByFolder([
      agentSession('shell-new', '/srv/app', 900, 'shell'),
      agentSession('claude-old', '/srv/app', 100, 'claude'),
    ]);
    expect(folders[0]?.sessions.map((s) => s.name)).toEqual(['claude-old', 'shell-new']);
  });

  it('falls back to activity-desc then name-asc within each agent/non-agent band', () => {
    const folders = groupSessionsByFolder([
      agentSession('b-shell', '/srv/app', 500, null),
      agentSession('a-shell', '/srv/app', 500, null),
      agentSession('codex-1', '/srv/app', 100, 'codex'),
      agentSession('claude-1', '/srv/app', 700, 'claude'),
    ]);
    expect(folders[0]?.sessions.map((s) => s.name)).toEqual([
      'claude-1',
      'codex-1',
      'a-shell',
      'b-shell',
    ]);
  });

  it('leaves rows with no agentKind at all ordered purely by recency', () => {
    const folders = groupSessionsByFolder([
      session('old', '/srv/app', 100),
      session('new', '/srv/app', 900),
    ]);
    expect(folders[0]?.sessions.map((s) => s.name)).toEqual(['new', 'old']);
  });
});

describe('canonicalisePath', () => {
  it('strips trailing slashes so /a/b/ and /a/b are one folder', () => {
    expect(canonicalisePath('/srv/app/')).toBe('/srv/app');
    expect(canonicalisePath('/srv/app')).toBe('/srv/app');
  });

  it('collapses blank/unknown to the untracked sentinel', () => {
    expect(canonicalisePath(null)).toBe(UNTRACKED_PATH);
    expect(canonicalisePath('')).toBe(UNTRACKED_PATH);
    expect(canonicalisePath('   ')).toBe(UNTRACKED_PATH);
  });

  it('keeps the filesystem root as /', () => {
    expect(canonicalisePath('/')).toBe('/');
    expect(canonicalisePath('///')).toBe('/');
  });

  it('does not expand ~', () => {
    expect(canonicalisePath('~/git/pocketshell')).toBe('~/git/pocketshell');
  });
});

describe('defaultLabelForPath', () => {
  it('uses the trailing path segment', () => {
    expect(defaultLabelForPath('/home/alexey/git/pocketshell')).toBe('pocketshell');
  });

  it('names the degenerate cases instead of rendering a blank header', () => {
    expect(defaultLabelForPath(UNTRACKED_PATH)).toBe(UNTRACKED_LABEL);
    expect(defaultLabelForPath('')).toBe(UNTRACKED_LABEL);
    expect(defaultLabelForPath('/')).toBe('/ (root)');
    expect(defaultLabelForPath('~')).toBe('~ (home)');
    expect(defaultLabelForPath('$HOME')).toBe('~ (home)');
  });
});

describe('groupSessionsByFolder', () => {
  it('buckets sessions by canonical working directory', () => {
    const folders = groupSessionsByFolder([
      session('a', '/srv/app', 300),
      session('b', '/srv/app/', 200),
      session('c', '/srv/other', 100),
    ]);
    expect(folders.map((f) => f.path)).toEqual(['/srv/app', '/srv/other']);
    expect(folders[0]!.sessions.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('orders folders by most-recent activity, descending', () => {
    const folders = groupSessionsByFolder([
      session('old', '/srv/old', 100),
      session('new', '/srv/new', 900),
      session('mid', '/srv/mid', 500),
    ]);
    expect(folders.map((f) => f.label)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks folder ties on a case-insensitive label', () => {
    const folders = groupSessionsByFolder([
      session('x', '/srv/Beta', 100),
      session('y', '/srv/alpha', 100),
    ]);
    expect(folders.map((f) => f.label)).toEqual(['alpha', 'Beta']);
  });

  it('sorts sessions inside a folder by activity desc then name', () => {
    const folders = groupSessionsByFolder([
      session('zulu', '/srv/app', 100),
      session('alpha', '/srv/app', 100),
      session('newest', '/srv/app', 500),
    ]);
    expect(folders[0]!.sessions.map((s) => s.name)).toEqual(['newest', 'alpha', 'zulu']);
  });

  it('pins the untracked bucket last even when it is the most recent', () => {
    const folders = groupSessionsByFolder([
      session('nowhere', null, 9_000),
      session('somewhere', '/srv/app', 10),
    ]);
    expect(folders.map((f) => f.label)).toEqual(['app', UNTRACKED_LABEL]);
  });

  it('falls back to created when activity is missing', () => {
    const stale: SessionSummary = {
      name: 's',
      created: 700,
      activity: 0,
      attached: false,
      path: '/srv/app',
    };
    expect(groupSessionsByFolder([stale])[0]!.mostRecentActivity).toBe(700);
  });

  it('marks a folder active when any of its sessions is attached', () => {
    const folders = groupSessionsByFolder([
      session('a', '/srv/app', 1, false),
      session('b', '/srv/app', 2, true),
      session('c', '/srv/idle', 3, false),
    ]);
    expect(folders.find((f) => f.path === '/srv/app')!.active).toBe(true);
    expect(folders.find((f) => f.path === '/srv/idle')!.active).toBe(false);
  });

  it('returns nothing for an empty session list', () => {
    expect(groupSessionsByFolder([])).toEqual([]);
  });
});

describe('inferHome', () => {
  it('reads the standard home layouts out of the paths themselves', () => {
    expect(inferHome(['/home/alexey/git/a'])).toBe('/home/alexey');
    expect(inferHome(['/Users/alexey/git/a'])).toBe('/Users/alexey');
    expect(inferHome(['/var/home/alexey/git/a'])).toBe('/var/home/alexey');
    expect(inferHome(['/root/git/a'])).toBe('/root');
    expect(inferHome(['/root'])).toBe('/root');
  });

  it('lets the majority win, so one stray path cannot move home', () => {
    expect(inferHome(['/home/alexey/git/a', '/home/alexey/git/b', '/root/scratch'])).toBe(
      '/home/alexey',
    );
  });

  it('returns null when nothing looks like a home directory', () => {
    expect(inferHome(['/srv/app', '/var/log', null, '   '])).toBeNull();
    expect(inferHome([])).toBeNull();
  });

  it('does not mistake the home parent itself for a home', () => {
    expect(inferHome(['/home'])).toBeNull();
    expect(inferHome(['/Users'])).toBeNull();
  });
});

describe('rootForPath', () => {
  const home = '/home/alexey';

  it('takes the first component under $HOME as the root', () => {
    expect(rootForPath('/home/alexey/git/dataops', home)).toEqual({ key: '~/git', label: 'git' });
    expect(rootForPath('/home/alexey/tmp/scratch', home)).toEqual({ key: '~/tmp', label: 'tmp' });
  });

  it('folds a literal ~ path onto the same root as its absolute spelling', () => {
    expect(rootForPath('~/git/dataops', home)).toEqual(rootForPath('/home/alexey/git/x', home));
  });

  it('resolves ~ without needing $HOME at all', () => {
    expect(rootForPath('~/git/dataops', null)).toEqual({ key: '~/git', label: 'git' });
  });

  it('keeps a root-level project folder as its own root', () => {
    expect(rootForPath('/home/alexey/git', home)).toEqual({ key: '~/git', label: 'git' });
  });

  it('buckets paths outside $HOME as other — they share no parent with the rest', () => {
    expect(rootForPath('/srv/app', home).key).toBe(OTHER_ROOT);
    expect(rootForPath('/var/log', home).key).toBe(OTHER_ROOT);
    expect(rootForPath('/', home).key).toBe(OTHER_ROOT);
  });

  it('buckets $HOME itself as other — there is no root folder to name', () => {
    expect(rootForPath('/home/alexey', home).key).toBe(OTHER_ROOT);
    expect(rootForPath('~', home).key).toBe(OTHER_ROOT);
    expect(rootForPath('$HOME', home).key).toBe(OTHER_ROOT);
  });

  it('buckets sessions with no known folder as other', () => {
    expect(rootForPath(UNTRACKED_PATH, home)).toEqual({ key: OTHER_ROOT, label: OTHER_LABEL });
  });

  it('sends absolute paths to other when home is neither known nor inferable', () => {
    expect(rootForPath('/opt/weird/git/x', null).key).toBe(OTHER_ROOT);
  });

  it('tolerates a trailing slash on the supplied home', () => {
    expect(rootForPath('/home/alexey/git/x', '/home/alexey/')).toEqual({
      key: '~/git',
      label: 'git',
    });
  });
});

describe('directoryKey', () => {
  const home = '/home/alexey';

  it('writes a directory under $HOME home-relative, at full depth', () => {
    expect(directoryKey('/home/alexey/git/dataops', home)).toBe('~/git/dataops');
  });

  it('folds the two spellings tmux reports for one directory into one key', () => {
    expect(directoryKey('~/git/dataops', home)).toBe(
      directoryKey('/home/alexey/git/dataops', home),
    );
  });

  it('resolves ~ without needing $HOME at all', () => {
    expect(directoryKey('~/git/dataops', null)).toBe('~/git/dataops');
  });

  it('keeps $HOME itself as ~', () => {
    expect(directoryKey('/home/alexey', home)).toBe('~');
    expect(directoryKey('~', home)).toBe('~');
  });

  it('leaves a path outside $HOME exactly as it is', () => {
    expect(directoryKey('/var/log', home)).toBe('/var/log');
    expect(directoryKey('/srv/app', null)).toBe('/srv/app');
  });

  it('passes the untracked sentinel through', () => {
    expect(directoryKey(UNTRACKED_PATH, home)).toBe(UNTRACKED_PATH);
  });
});

describe('rootFromSessionName', () => {
  it('reads the root back out of a derived name', () => {
    expect(rootFromSessionName('git-red-stamp-sound', ['git', 'tmp'])).toBe('git');
    expect(rootFromSessionName('tmp-scratch', ['git', 'tmp'])).toBe('tmp');
  });

  it('matches a name that is exactly one component', () => {
    expect(rootFromSessionName('git', ['git'])).toBe('git');
  });

  it('refuses to conjure a root nothing else lives in', () => {
    expect(rootFromSessionName('foo-bar', ['git', 'tmp'])).toBeNull();
    expect(rootFromSessionName('git-a', [])).toBeNull();
  });

  it('compares against the sanitised root name, as the derivation wrote it', () => {
    expect(rootFromSessionName('my_project-thing', ['my.project'])).toBe('my.project');
  });

  it('returns null for a name with no usable leading component', () => {
    expect(rootFromSessionName('', ['git'])).toBeNull();
    expect(rootFromSessionName('---', ['git'])).toBeNull();
  });
});

describe('groupSessionsIntoRoots', () => {
  const home = '/home/alexey';

  /** Every session under a root, in render order, across its directories. */
  function sessionNames(root: SessionRootFolder): string[] {
    return root.directories.flatMap((d) => d.rows.map((r) => r.session.name));
  }

  it('renders one root per $HOME child, holding that root directories', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-dataops', '/home/alexey/git/dataops', 300),
        session('git-pocketshell', '/home/alexey/git/pocketshell', 200),
        session('tmp-scratch', '/home/alexey/tmp/scratch', 100),
      ],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['git', 'tmp']);
    expect(roots[0]!.directories.map((d) => d.label)).toEqual(['dataops', 'pocketshell']);
    expect(roots[0]!.sessionCount).toBe(2);
    expect(roots[1]!.directories.map((d) => d.label)).toEqual(['scratch']);
  });

  it('names a lone session row after its DIRECTORY, not after the session', () => {
    const [git] = groupSessionsIntoRoots(
      [session('git-dtc-website', '/home/alexey/git/merry-sniffing-token', 100)],
      home,
    );
    const [dir] = git!.directories;
    // The worktree case: the name diverges from the folder, and the folder
    // still wins the row. The name is not lost — it is in the tooltip.
    expect(dir!.label).toBe('merry-sniffing-token');
    expect(dir!.rows).toHaveLength(1);
    expect(dir!.rows[0]!.session.name).toBe('git-dtc-website');
  });

  it('keeps a single-session directory flat — no branch, no extra row', () => {
    const [git] = groupSessionsIntoRoots(
      [session('git-dataops', '/home/alexey/git/dataops', 100)],
      home,
    );
    expect(git!.directories).toHaveLength(1);
    expect(git!.directories[0]!.rows).toHaveLength(1);
    expect(git!.directories[0]!.path).toBe('~/git/dataops');
  });

  it('branches a directory holding more than one session, listing them by name', () => {
    const [git] = groupSessionsIntoRoots(
      [
        session('git-pocketshell', '/home/alexey/git/pocketshell', 200),
        session('git-pocketshell-quse', '/home/alexey/git/pocketshell', 100),
        session('git-dataops', '/home/alexey/git/dataops', 50),
      ],
      home,
    );
    const branch = git!.directories.find((d) => d.label === 'pocketshell')!;
    expect(branch.rows.map((r) => r.session.name)).toEqual([
      'git-pocketshell',
      'git-pocketshell-quse',
    ]);
    // The child label is the session name, split for middle truncation — the
    // siblings share a derived prefix, so an end-ellipsis would merge them.
    expect(branch.rows.map((r) => r.nameHead + r.nameTail)).toEqual([
      'git-pocketshell',
      'git-pocketshell-quse',
    ]);
    expect(branch.rows[1]!.nameTail).toBe('ell-quse');
    expect(git!.directories.find((d) => d.label === 'dataops')!.rows).toHaveLength(1);
  });

  it('gives a branch the newest age and the aggregate dot of its sessions', () => {
    const [git] = groupSessionsIntoRoots(
      [
        session('git-app-a', '/home/alexey/git/app', 100),
        session('git-app-b', '/home/alexey/git/app', 900, true),
      ],
      home,
    );
    expect(git!.directories[0]!.mostRecentActivity).toBe(900);
    expect(git!.directories[0]!.active).toBe(true);
  });

  it('folds the two spellings of one directory into a single node, not two rows', () => {
    const [git] = groupSessionsIntoRoots(
      [
        session('git-app-a', '/home/alexey/git/app', 300),
        session('git-app-b', '~/git/app', 200),
      ],
      home,
    );
    expect(git!.directories).toHaveLength(1);
    expect(git!.directories[0]!.rows).toHaveLength(2);
  });

  it('infers home when it was not supplied, instead of dumping everything in other', () => {
    const roots = groupSessionsIntoRoots([
      session('git-a', '/home/alexey/git/a', 300),
      session('tmp-b', '/home/alexey/tmp/b', 200),
    ]);
    expect(roots.map((r) => r.label)).toEqual(['git', 'tmp']);
  });

  it('collects untracked and out-of-home sessions into one other bucket', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-a', '/home/alexey/git/a', 300),
        session('var-log', '/var/log', 200),
        session('nowhere', null, 100),
      ],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['git', OTHER_LABEL]);
    expect(roots[1]!.other).toBe(true);
    expect(sessionNames(roots[1]!)).toEqual(['var-log', 'nowhere']);
    // `/var/log` is a real directory and gets a directory row like any other.
    expect(roots[1]!.directories[0]!.label).toBe('log');
  });

  it('names a directory that IS $HOME after home, not after the account', () => {
    // The directory key collapses to `~`, so the leaf component is gone and
    // `defaultLabelForPath`'s named fallback takes over. That is the better
    // label anyway: a row reading `alexey` looks like a user, not a project.
    const [other] = groupSessionsIntoRoots([session('home-alexey', '/home/alexey', 100)], home);
    expect(other!.directories[0]!.label).toBe('~ (home)');
    expect(other!.directories[0]!.path).toBe('~');
  });

  it('pins other last however recent it is', () => {
    const roots = groupSessionsIntoRoots(
      [session('unplaceable', null, 9_000), session('git-a', '/home/alexey/git/a', 10)],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['git', OTHER_LABEL]);
  });

  it('orders roots by most-recent activity, then case-insensitive label', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('a', '/home/alexey/old/a', 100),
        session('b', '/home/alexey/new/b', 900),
        session('c', '/home/alexey/mid/c', 500),
      ],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['new', 'mid', 'old']);
    expect(roots[0]!.mostRecentActivity).toBe(900);
  });

  it('breaks a root tie on a case-insensitive label', () => {
    const roots = groupSessionsIntoRoots(
      [session('x', '/home/alexey/Beta/x', 100), session('y', '/home/alexey/alpha/y', 100)],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['alpha', 'Beta']);
  });

  it('orders directories attached-first, then recency, then label', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-old', '/home/alexey/git/old', 100),
        session('git-new', '/home/alexey/git/new', 900),
        session('git-live', '/home/alexey/git/live', 10, true),
      ],
      home,
    );
    expect(roots[0]!.directories.map((d) => d.label)).toEqual(['live', 'new', 'old']);
  });

  it('keeps attached-first inside a branch too', () => {
    const [git] = groupSessionsIntoRoots(
      [
        session('git-app-new', '/home/alexey/git/app', 900),
        session('git-app-live', '/home/alexey/git/app', 10, true),
      ],
      home,
    );
    expect(git!.directories[0]!.rows.map((r) => r.session.name)).toEqual([
      'git-app-live',
      'git-app-new',
    ]);
  });

  it('marks a root active when any session under it is attached', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-a', '/home/alexey/git/a', 1, false),
        session('git-b', '/home/alexey/git/b', 2, true),
        session('tmp-c', '/home/alexey/tmp/c', 3, false),
      ],
      home,
    );
    expect(roots.find((r) => r.label === 'git')!.active).toBe(true);
    expect(roots.find((r) => r.label === 'tmp')!.active).toBe(false);
  });

  it('renders an untracked session as its own row, under its own name', () => {
    const [other] = groupSessionsIntoRoots([session('foreign-0', null, 100)], home);
    const [dir] = other!.directories;
    expect(dir!.untracked).toBe(true);
    expect(dir!.label).toBe('foreign-0');
    expect(dir!.rows).toHaveLength(1);
  });

  it('never merges untracked sessions into one Untracked branch', () => {
    const [other] = groupSessionsIntoRoots(
      [session('foreign-0', null, 200), session('foreign-1', null, 100)],
      home,
    );
    expect(other!.directories.map((d) => d.label)).toEqual(['foreign-0', 'foreign-1']);
    expect(other!.directories.every((d) => d.rows.length === 1)).toBe(true);
  });

  it('files a session with no reported cwd under the root its NAME names', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-dataops', '/home/alexey/git/dataops', 300),
        session('git-red-stamp-sound', null, 200),
      ],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['git']);
    const recovered = roots[0]!.directories.find((d) => d.untracked)!;
    expect(recovered.label).toBe('git-red-stamp-sound');
    expect(recovered.inferredRoot).toBe(true);
  });

  it('leaves a name-recovered session as a direct child, inventing no directory', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-dataops', '/home/alexey/git/dataops', 300),
        // Ambiguous between ~/git/dtc-website-import and ~/git/dtc-website/import.
        session('git-dtc-website-import', null, 200),
      ],
      home,
    );
    const recovered = roots[0]!.directories.find((d) => d.untracked)!;
    expect(recovered.path).toBe(UNTRACKED_PATH);
    expect(recovered.label).toBe('git-dtc-website-import');
  });

  it('still drops a no-cwd session into other when no root matches its name', () => {
    const roots = groupSessionsIntoRoots(
      [session('git-dataops', '/home/alexey/git/dataops', 300), session('weird-thing', null, 200)],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['git', OTHER_LABEL]);
    expect(sessionNames(roots[1]!)).toEqual(['weird-thing']);
    expect(roots[1]!.directories[0]!.inferredRoot).toBe(false);
  });

  it('does not let a name-recovered session create the root it was filed under', () => {
    // `git` exists only in the NAME here, never in a real path, so nothing may
    // be filed into it — otherwise the heuristic invents the structure it is
    // supposed to be reading.
    const roots = groupSessionsIntoRoots([session('git-ghost', null, 200)], home);
    expect(roots.map((r) => r.label)).toEqual([OTHER_LABEL]);
  });

  it('grows colliding directory labels apart within a root, not across roots', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('a', '/home/alexey/git/foo', 400),
        session('b', '/home/alexey/git/nested/foo', 300),
        session('c', '/home/alexey/work/foo', 200),
      ],
      home,
    );
    const git = roots.find((r) => r.label === 'git')!;
    const work = roots.find((r) => r.label === 'work')!;
    expect(git.directories.map((d) => d.label).sort()).toEqual(['git/foo', 'nested/foo']);
    // Already separated by their headers, so `work` keeps the bare basename.
    expect(work.directories.map((d) => d.label)).toEqual(['foo']);
  });

  it('returns nothing for an empty session list', () => {
    expect(groupSessionsIntoRoots([], home)).toEqual([]);
  });
});
