import { describe, it, expect } from 'vitest';
import {
  UNTRACKED_LABEL,
  UNTRACKED_PATH,
  canonicalisePath,
  defaultLabelForPath,
  groupSessionsByFolder,
} from '../../src/renderer/sessionGrouping';
import type { SessionSummary } from '../../src/shared/types';

/** Terse SessionSummary factory — only the fields grouping cares about. */
function session(
  name: string,
  path: string | null,
  activity: number,
  attached = false,
): SessionSummary {
  return { name, created: activity, activity, attached, path };
}

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
