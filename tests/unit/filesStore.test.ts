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
const stat =
  vi.fn<(connectionId: string, path: string) => Promise<{ size: number; type?: string }>>();
const readBinary =
  vi.fn<(connectionId: string, path: string, maxBytes?: number) => Promise<Uint8Array>>();
const readFile = vi.fn<(connectionId: string, path: string) => Promise<string>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    sftp: {
      realPath: (connectionId: string, path: string) => realPath(connectionId, path),
      list: (connectionId: string, path: string) => list(connectionId, path),
      stat: (connectionId: string, path: string) => stat(connectionId, path),
      readBinary: (connectionId: string, path: string, maxBytes?: number) =>
        readBinary(connectionId, path, maxBytes),
      readFile: (connectionId: string, path: string) => readFile(connectionId, path),
    },
  },
}));

// jsdom does not implement object URLs; the store only ever mints and revokes
// them, so a counter is enough to assert it does not leak one per click.
const created: string[] = [];
const revoked: string[] = [];
globalThis.URL.createObjectURL = (): string => {
  const url = `blob:mock/${created.length}`;
  created.push(url);
  return url;
};
globalThis.URL.revokeObjectURL = (url: string): void => {
  revoked.push(url);
};

const { useFilesStore, stripTilde, resolveTerminalPath, MAX_TEXT_BYTES } = await import(
  '../../src/renderer/stores/files'
);

const CONN = 'conn-1' as never;

beforeEach(() => {
  setActivePinia(createPinia());
  realPath.mockReset();
  list.mockReset();
  stat.mockReset();
  readBinary.mockReset();
  readFile.mockReset();
  list.mockResolvedValue([]);
  created.length = 0;
  revoked.length = 0;
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

/**
 * Leaving the Files tab must not cost the user their place.
 *
 * The tab is behind a `v-if`, so switching to Terminal unmounts the view.
 * That unmount used to call `clear()`, which reset `cwd` — so coming back
 * re-ran `open()` and dropped the user at the session's start directory (or,
 * while the session cwd was missing, at the login home) no matter how deep
 * they had navigated. The position is now remembered per connection AND per
 * session, which is what stops one session's directory becoming another's.
 */
describe('files store remembers where each session was left', () => {
  it('returns to the directory the user navigated to, not the start path', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p === 'git/app' ? '/home/u/git/app' : p));
    const files = useFilesStore();

    await files.open(CONN, '~/git/app');
    await files.cd(CONN, '/home/u/git/app/src/deep');
    expect(files.cwd).toBe('/home/u/git/app/src/deep');

    // Terminal tab -> Files tab: the view unmounts and re-mounts, so `open`
    // runs again with the same start path.
    await files.open(CONN, '~/git/app');

    expect(files.cwd).toBe('/home/u/git/app/src/deep');
  });

  it('does not leak one session\u2019s directory into another\u2019s', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    const files = useFilesStore();

    await files.open(CONN, '/home/u/git/app');
    await files.cd(CONN, '/home/u/git/app/src');

    // A different session, with its own working directory.
    await files.open(CONN, '/home/u/git/other');
    expect(files.cwd).toBe('/home/u/git/other');

    // ...and going back to the first still lands where it was left.
    await files.open(CONN, '/home/u/git/app');
    expect(files.cwd).toBe('/home/u/git/app/src');
  });

  it('uses a newly recovered session path on the first visit after the fix', async () => {
    // Before the cwd bug was fixed this session had `path: null`, so the tab
    // opened at the login home. Once tmux's answer comes through, the FIRST
    // visit must honour it rather than a home remembered from before.
    realPath.mockImplementation((_c, p) => Promise.resolve(p === '.' ? '/home/u' : p));
    const files = useFilesStore();

    await files.open(CONN, undefined);
    expect(files.cwd).toBe('/home/u');

    await files.open(CONN, '/home/u/git/red-stamp-sound');

    expect(files.cwd).toBe('/home/u/git/red-stamp-sound');
  });

  it('keeps an unsaved edit across a tab switch instead of discarding it', async () => {
    // A clean buffer is a cache and is cheap to rebuild; an unsaved edit
    // exists nowhere else, so throwing it away silently would be worse than
    // the bug this whole mechanism fixes.
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 12 });
    readBinary.mockResolvedValue(new TextEncoder().encode('hello world\n'));
    const files = useFilesStore();

    await files.open(CONN, '/home/u/git/app');
    await files.openFile(CONN, 'notes.md');
    files.setContent('edited, not saved');

    await files.open(CONN, '/home/u/git/other');
    expect(files.openPath).toBeNull();

    await files.open(CONN, '/home/u/git/app');
    expect(files.openContent).toBe('edited, not saved');
    expect(files.dirty).toBe(true);
  });

  it('forgets a connection on disconnect, which is what clear() is for', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    const files = useFilesStore();

    await files.open(CONN, '/home/u/git/app');
    await files.cd(CONN, '/home/u/git/app/src');
    files.clear(CONN);

    expect(files.cwd).toBe('');
    await files.open(CONN, '/home/u/git/app');
    expect(files.cwd).toBe('/home/u/git/app');
  });
});

/**
 * The freeze: clicking an mp3 read it as UTF-8 and bound megabytes of
 * replacement characters to a textarea.
 *
 * The invariant these pin is that `openMode` is `text` only for bytes that
 * decoded as text, and that every other outcome — including every FAILURE —
 * ends in the binary panel rather than in the editor.
 */
describe('files store openFile() type gating', () => {
  const openIn = async (name: string, bytes?: Uint8Array, size?: number) => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: size ?? bytes?.length ?? 0 });
    if (bytes) readBinary.mockResolvedValue(bytes);
    const files = useFilesStore();
    await files.open(CONN, '/home/u');
    await files.openFile(CONN, name);
    return files;
  };

  it('plays audio instead of decoding it', async () => {
    const files = await openIn('song.mp3', new Uint8Array([0x49, 0x44, 0x33, 0x04, 0xff, 0xfb]));

    expect(files.openMode).toBe('audio');
    expect(files.openMime).toBe('audio/mpeg');
    expect(files.openUrl).toBeTruthy();
    expect(files.openContent).toBe('');
  });

  it('renders a PDF instead of decoding it', async () => {
    const files = await openIn('paper.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));

    expect(files.openMode).toBe('pdf');
    expect(files.openMime).toBe('application/pdf');
    expect(files.openUrl).toBeTruthy();
  });

  it('never uses readFile — the UTF-8 path is gone entirely', async () => {
    await openIn('song.mp3', new Uint8Array([0x49, 0x44, 0x33]));
    expect(readFile).not.toHaveBeenCalled();
  });

  it('opens ordinary text in the editor', async () => {
    const files = await openIn('notes.md', new TextEncoder().encode('# hi\n'));

    expect(files.openMode).toBe('text');
    expect(files.openContent).toBe('# hi\n');
    expect(files.openUrl).toBeNull();
  });

  it('refuses an oversized text file without transferring it', async () => {
    const files = await openIn('huge.log', undefined, MAX_TEXT_BYTES + 1);

    expect(files.openMode).toBe('binary');
    expect(files.openNote).toContain('limit');
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('refuses a known-binary type from the listing alone', async () => {
    const files = await openIn('dump.zip', undefined, 4096);

    expect(files.openMode).toBe('binary');
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('shows the binary panel, not text, when the read fails', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 10 });
    readBinary.mockRejectedValue(new Error('Permission denied'));
    const files = useFilesStore();
    await files.open(CONN, '/home/u');

    await files.openFile(CONN, 'thing.mp3');

    expect(files.openMode).toBe('binary');
    expect(files.openContent).toBe('');
    expect(files.openNote).toContain('Permission denied');
  });

  it('revokes the previous object URL when another file is opened', async () => {
    const files = await openIn('a.mp3', new Uint8Array([0x49, 0x44, 0x33]));
    const first = files.openUrl;

    readBinary.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    await files.openFile(CONN, 'b.pdf');

    expect(revoked).toContain(first);
  });
});

/**
 * Resolving a path that was PRINTED, not browsed to.
 *
 * The rule here is the one the Files tab already fought for once: a session's
 * relative path is relative to where that SESSION runs, which is neither the
 * login home nor wherever this tab happens to be pointing. The second half is
 * that the session's own cwd can be an unexpanded `~/git/foo`, so the base has
 * to go through the same `stripTilde` the tab's own opening does.
 */
describe('resolveTerminalPath', () => {
  it('joins a relative path onto the session cwd, not the login home', () => {
    expect(resolveTerminalPath('tmp/a.mp3', '/home/alexey/git/foo')).toBe(
      '/home/alexey/git/foo/tmp/a.mp3',
    );
  });

  it('strips a tilde session cwd so the join stays SFTP-resolvable', () => {
    // `~/git/foo` + `tmp/a.mp3` must not become a directory literally named `~`.
    expect(resolveTerminalPath('tmp/a.mp3', '~/git/foo')).toBe('git/foo/tmp/a.mp3');
  });

  it('leaves an absolute path exactly as printed', () => {
    expect(resolveTerminalPath('/srv/media/a.mp3', '/home/alexey')).toBe('/srv/media/a.mp3');
  });

  it('anchors a tilde path on the home, ignoring the session cwd', () => {
    expect(resolveTerminalPath('~/notes.md', '/home/alexey/git/foo')).toBe('notes.md');
  });

  it('falls back to home-relative when the session reported no path', () => {
    // Same fallback `open()` makes for the same missing fact.
    expect(resolveTerminalPath('tmp/a.mp3', null)).toBe('tmp/a.mp3');
    expect(resolveTerminalPath('tmp/a.mp3', undefined)).toBe('tmp/a.mp3');
  });

  it('drops a leading ./ rather than embedding it in the join', () => {
    expect(resolveTerminalPath('./tmp/a.mp3', '/home/alexey')).toBe('/home/alexey/tmp/a.mp3');
  });

  it('leaves .. for the remote realpath to fold', () => {
    // Folding it here would mean guessing about symlinks only the host knows.
    expect(resolveTerminalPath('../b.txt', '/home/alexey/git')).toBe('/home/alexey/git/../b.txt');
  });
});

describe('files store reveal', () => {
  it('parks the resolved path for the Files tab to take exactly once', () => {
    const files = useFilesStore();

    files.requestReveal('tmp/a.mp3', '~/git/foo');

    expect(files.reveal).toBe('git/foo/tmp/a.mp3');
    expect(files.takeReveal()).toBe('git/foo/tmp/a.mp3');
    expect(files.reveal).toBeNull();
    expect(files.takeReveal()).toBeNull();
  });

  it('opens a file and moves the listing to its directory', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 3, type: 'file' });
    readBinary.mockResolvedValue(new Uint8Array([0x49, 0x44, 0x33]));
    const files = useFilesStore();
    await files.open(CONN, '/home/alexey/git/foo');

    await files.revealPath(CONN, '/home/alexey/git/foo/tmp/a.mp3');

    expect(files.cwd).toBe('/home/alexey/git/foo/tmp');
    expect(files.openPath).toBe('/home/alexey/git/foo/tmp/a.mp3');
    expect(files.openMode).toBe('audio');
    expect(files.error).toBeNull();
  });

  it('enters a directory rather than trying to open it as a file', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 0, type: 'dir' });
    const files = useFilesStore();
    await files.open(CONN, '/home/alexey');

    await files.revealPath(CONN, '/home/alexey/git');

    expect(files.cwd).toBe('/home/alexey/git');
    expect(files.openPath).toBeNull();
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('says so when the optimistically-linked path does not exist', async () => {
    // Terminal output is linkified without ever being stat'ed, so a dead link
    // is a NORMAL outcome and has to arrive as a message rather than silence.
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockRejectedValue(new Error('No such file'));
    const files = useFilesStore();
    await files.open(CONN, '/home/alexey');
    const before = files.cwd;

    await files.revealPath(CONN, '/home/alexey/gone.mp3');

    expect(files.error).toContain('gone.mp3');
    expect(files.error).toContain('No such file');
    // And the user is left where they were, not somewhere half-navigated.
    expect(files.cwd).toBe(before);
    expect(files.openPath).toBeNull();
  });

  it('reports a path that will not even resolve', async () => {
    realPath.mockImplementation((_c, p) =>
      p === '/home/alexey' ? Promise.resolve(p) : Promise.reject(new Error('Permission denied')),
    );
    const files = useFilesStore();
    await files.open(CONN, '/home/alexey');

    await files.revealPath(CONN, '/root/secret.txt');

    expect(files.error).toContain('/root/secret.txt');
    expect(files.error).toContain('Permission denied');
  });
});
