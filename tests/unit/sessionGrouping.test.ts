import { describe, it, expect } from 'vitest';
import {
  UNTRACKED_LABEL,
  UNTRACKED_PATH,
  canonicalisePath,
  defaultLabelForPath,
  OTHER_LABEL,
  OTHER_ROOT,
  groupSessionsByFolder,
  groupSessionsIntoRoots,
  inferHome,
  isAgentSession,
  rootForPath,
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

describe('groupSessionsIntoRoots', () => {
  const home = '/home/alexey';

  it('renders one root per $HOME child, holding that root’s sessions', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-dataops', '/home/alexey/git/dataops', 300),
        session('git-pocketshell', '/home/alexey/git/pocketshell', 200),
        session('tmp-scratch', '/home/alexey/tmp/scratch', 100),
      ],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['git', 'tmp']);
    expect(roots[0]!.rows.map((r) => r.session.name)).toEqual(['git-dataops', 'git-pocketshell']);
    expect(roots[1]!.rows.map((r) => r.session.name)).toEqual(['tmp-scratch']);
  });

  it('infers home when it was not supplied, instead of dumping everything in other', () => {
    const roots = groupSessionsIntoRoots([
      session('git-a', '/home/alexey/git/a', 300),
      session('tmp-b', '/home/alexey/tmp/b', 200),
    ]);
    expect(roots.map((r) => r.label)).toEqual(['git', 'tmp']);
  });

  it('folds the two spellings of one directory into a single root', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-a', '/home/alexey/git/a', 300),
        session('git-b', '~/git/b', 200),
      ],
      home,
    );
    expect(roots).toHaveLength(1);
    expect(roots[0]!.rows).toHaveLength(2);
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
    expect(roots[1]!.rows.map((r) => r.session.name)).toEqual(['var-log', 'nowhere']);
  });

  it('pins other last however recent it is', () => {
    const roots = groupSessionsIntoRoots(
      [session('nowhere', null, 9_000), session('git-a', '/home/alexey/git/a', 10)],
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

  it('keeps the flat list order inside a root: attached first, then recency', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-old', '/home/alexey/git/old', 100),
        session('git-new', '/home/alexey/git/new', 900),
        session('git-live', '/home/alexey/git/live', 10, true),
      ],
      home,
    );
    expect(roots[0]!.rows.map((r) => r.session.name)).toEqual(['git-live', 'git-new', 'git-old']);
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

  it('suppresses a session name that is just its folder restated', () => {
    const [git] = groupSessionsIntoRoots(
      [session('git-dataops', '/home/alexey/git/dataops', 100)],
      home,
    );
    expect(git!.rows[0]!.label).toBe('dataops');
    expect(git!.rows[0]!.showName).toBe(false);
  });

  it('still shows a name the folder does not account for (the worktree case)', () => {
    const [git] = groupSessionsIntoRoots(
      [session('git-dtc-website', '/home/alexey/git/merry-sniffing-tortoise', 100)],
      home,
    );
    expect(git!.rows[0]!.label).toBe('merry-sniffing-tortoise');
    expect(git!.rows[0]!.showName).toBe(true);
  });

  it('shows names for siblings in one folder, which a shared label cannot separate', () => {
    const [git] = groupSessionsIntoRoots(
      [
        session('git-dataops', '/home/alexey/git/dataops', 200),
        session('git-dataops-2', '/home/alexey/git/dataops', 100),
      ],
      home,
    );
    expect(git!.rows.every((r) => r.showName)).toBe(true);
  });

  it('renders an untracked row under its own name, in mono', () => {
    const [other] = groupSessionsIntoRoots([session('foreign-0', null, 100)], home);
    expect(other!.rows[0]!.untracked).toBe(true);
    expect(other!.rows[0]!.label).toBe('foreign-0');
    expect(other!.rows[0]!.showName).toBe(false);
  });

  it('grows colliding labels apart within a root, and leaves them alone across roots', () => {
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
    expect(git.rows.map((r) => r.label).sort()).toEqual(['git/foo', 'nested/foo']);
    // Already separated by their headers, so `work` keeps the bare basename.
    expect(work.rows.map((r) => r.label)).toEqual(['foo']);
  });

  it('returns nothing for an empty session list', () => {
    expect(groupSessionsIntoRoots([], home)).toEqual([]);
  });
});
