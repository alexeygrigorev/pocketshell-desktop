import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The Files tab's opening behaviour.
 *
 * The rule these pin is "open where the session is running, not where the user
 * logs in". Two things used to break it, and both are state rules rather than
 * layout ones, so they are driven through the store:
 *
 *  - a session cwd that tmux reports as a literal, unexpanded `~/git/...`,
 *    which an SFTP channel cannot resolve because it has no shell to expand
 *    the tilde;
 *  - a resolve that rejects, which escaped `open()` entirely and left `cwd`
 *    empty — and since `refresh()` early-returns on an empty cwd, nothing ever
 *    populated `entries` OR set `error`. The pane rendered an empty directory
 *    and said nothing, which reads as "the session's folder is empty" rather
 *    than "we never got there".
 */

const realPath = vi.fn<(connectionId: string, path: string) => Promise<string>>();
const list = vi.fn<(connectionId: string, path: string) => Promise<unknown[]>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    sftp: {
      realPath: (connectionId: string, path: string) => realPath(connectionId, path),
      list: (connectionId: string, path: string) => list(connectionId, path),
    },
  },
}));

const { useFilesStore, stripTilde } = await import('../../src/renderer/stores/files');

const CONN = 'conn-1' as never;

beforeEach(() => {
  setActivePinia(createPinia());
  realPath.mockReset();
  list.mockReset();
  list.mockResolvedValue([]);
});

describe('stripTilde', () => {
  it('drops a leading ~/ so the path resolves relative to the login home', () => {
    // An SFTP session's relative root IS the home directory, so this reaches
    // the same place `~/git` names without costing a lookup to expand it.
    expect(stripTilde('~/git/pocketshell')).toBe('git/pocketshell');
  });

  it('maps a bare ~ and an empty path to the home directory', () => {
    expect(stripTilde('~')).toBe('.');
    expect(stripTilde('~/')).toBe('.');
    expect(stripTilde(undefined)).toBe('.');
    expect(stripTilde('')).toBe('.');
  });

  it('passes absolute paths through untouched', () => {
    expect(stripTilde('/home/alexey/git')).toBe('/home/alexey/git');
  });

  it("leaves another user's ~home alone rather than resolving it wrongly", () => {
    // `~other/x` is not our home; resolving it relatively would silently open
    // the wrong directory, and failing honestly is better than that.
    expect(stripTilde('~other/x')).toBe('~other/x');
  });
});

describe('files store open()', () => {
  it('opens the session directory, not the home directory', async () => {
    realPath.mockResolvedValue('/home/alexey/git/pocketshell');
    const files = useFilesStore();

    await files.open(CONN, '/home/alexey/git/pocketshell');

    expect(realPath).toHaveBeenCalledWith(CONN, '/home/alexey/git/pocketshell');
    expect(files.cwd).toBe('/home/alexey/git/pocketshell');
    expect(files.error).toBeNull();
  });

  it('resolves a tilde session cwd instead of failing on it', async () => {
    realPath.mockResolvedValue('/home/alexey/git');
    const files = useFilesStore();

    await files.open(CONN, '~/git');

    // The tilde never reaches SFTP.
    expect(realPath).toHaveBeenCalledWith(CONN, 'git');
    expect(files.cwd).toBe('/home/alexey/git');
    expect(files.error).toBeNull();
  });

  it('falls back to home AND says why when the session cwd will not resolve', async () => {
    realPath.mockRejectedValueOnce(new Error('No such file')).mockResolvedValueOnce('/home/alexey');
    const files = useFilesStore();

    await files.open(CONN, '/gone');

    expect(files.cwd).toBe('/home/alexey');
    // The note survives `refresh()`, which clears `error` on entry.
    expect(files.error).toContain('/gone');
    expect(files.error).toContain('No such file');
  });

  it('reports the failure rather than rendering a silent empty directory', async () => {
    realPath.mockRejectedValue(new Error('Channel closed'));
    const files = useFilesStore();

    await files.open(CONN, '~/git');

    expect(files.cwd).toBe('');
    expect(files.entries).toEqual([]);
    expect(files.error).toBe('Channel closed');
  });
});
