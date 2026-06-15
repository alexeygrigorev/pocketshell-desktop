/**
 * Unit tests for FileBrowser.
 *
 * Uses a mocked SftpClient to test navigation, caching, and sorting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileBrowser, remoteFileUriParts, resolveFileBrowserStartDirectory } from '../../../src/files/file-browser';
import type { SftpClient } from '../../../src/files/sftp-client';
import type { RemoteFileEntry } from '../../../src/files/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(name: string, overrides: Partial<RemoteFileEntry> = {}): RemoteFileEntry {
  return {
    name,
    path: `/home/${name}`,
    isDirectory: false,
    isFile: true,
    isSymbolicLink: false,
    size: 100,
    modifiedAt: Date.now(),
    ...overrides,
  };
}

function makeDirEntry(name: string, overrides: Partial<RemoteFileEntry> = {}): RemoteFileEntry {
  return makeEntry(name, {
    isDirectory: true,
    isFile: false,
    size: 4096,
    ...overrides,
  });
}

function createMockSftpClient(listings: Map<string, RemoteFileEntry[]>): {
  client: SftpClient;
  readdirMock: ReturnType<typeof vi.fn>;
  realpathMock: ReturnType<typeof vi.fn>;
} {
  const readdirMock = vi.fn().mockImplementation(async (path: string) => {
    const entries = listings.get(path);
    if (!entries) throw new Error(`No such directory: ${path}`);
    return [...entries]; // Return copies
  });

  const realpathMock = vi.fn().mockResolvedValue('/home/testuser');

  const client = {
    readdir: readdirMock,
    realpath: realpathMock,
  } as unknown as SftpClient;

  return { client, readdirMock, realpathMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileBrowser', () => {
  let mockBundle: ReturnType<typeof createMockSftpClient>;
  let listings: Map<string, RemoteFileEntry[]>;

  beforeEach(() => {
    listings = new Map();
    mockBundle = createMockSftpClient(listings);
  });

  describe('navigate', () => {
    it('lists directory entries', async () => {
      listings.set('/home', [
        makeEntry('file.txt'),
        makeDirEntry('docs'),
      ]);

      const browser = new FileBrowser(mockBundle.client);
      const entries = await browser.navigate('/home');

      expect(entries).toHaveLength(2);
      expect(browser.currentPath).toBe('/home');
      expect(browser.currentEntries).toBe(entries);
    });

    it('sorts entries: directories first, then alphabetical', async () => {
      listings.set('/home', [
        makeEntry('zebra.txt'),
        makeDirEntry('beta'),
        makeEntry('alpha.txt'),
        makeDirEntry('alpha'),
      ]);

      const browser = new FileBrowser(mockBundle.client);
      const entries = await browser.navigate('/home');

      expect(entries.map((e) => e.name)).toEqual(['alpha', 'beta', 'alpha.txt', 'zebra.txt']);
    });

    it('filters hidden files when showHidden is false', async () => {
      listings.set('/home', [
        makeEntry('.bashrc'),
        makeEntry('visible.txt'),
        makeEntry('.hidden'),
      ]);

      const browser = new FileBrowser(mockBundle.client, { showHidden: false });
      const entries = await browser.navigate('/home');

      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('visible.txt');
    });

    it('includes hidden files when showHidden is true', async () => {
      listings.set('/home', [
        makeEntry('.bashrc'),
        makeEntry('visible.txt'),
        makeEntry('.hidden'),
      ]);

      const browser = new FileBrowser(mockBundle.client, { showHidden: true });
      const entries = await browser.navigate('/home');

      expect(entries).toHaveLength(3);
    });

    it('fires navigation event', async () => {
      listings.set('/home', [makeEntry('file.txt')]);

      const browser = new FileBrowser(mockBundle.client);
      const events: Array<{ path: string; entries: RemoteFileEntry[] }> = [];
      browser.onNavigate((path, entries) => {
        events.push({ path, entries });
      });

      await browser.navigate('/home');

      expect(events).toHaveLength(1);
      expect(events[0].path).toBe('/home');
      expect(events[0].entries).toHaveLength(1);
    });

    it('unsubscribe stops receiving events', async () => {
      listings.set('/home', [makeEntry('file.txt')]);
      listings.set('/tmp', [makeEntry('other.txt')]);

      const browser = new FileBrowser(mockBundle.client);
      const events: string[] = [];
      const unsub = browser.onNavigate((path) => {
        events.push(path);
      });

      await browser.navigate('/home');
      unsub();
      await browser.navigate('/tmp');

      expect(events).toEqual(['/home']);
    });
  });

  describe('goUp', () => {
    it('navigates to parent directory', async () => {
      listings.set('/home', [makeEntry('file.txt')]);
      listings.set('/', [makeDirEntry('home')]);

      const browser = new FileBrowser(mockBundle.client);
      await browser.navigate('/home');
      const entries = await browser.goUp();

      expect(browser.currentPath).toBe('/');
      expect(entries).toBeDefined();
    });

    it('goes to root from /sub/dir', async () => {
      listings.set('/sub/dir', [makeEntry('deep.txt')]);
      listings.set('/sub', [makeDirEntry('dir')]);

      const browser = new FileBrowser(mockBundle.client);
      await browser.navigate('/sub/dir');
      await browser.goUp();

      expect(browser.currentPath).toBe('/sub');
    });

    it('stays at root when going up from root', async () => {
      listings.set('/', [makeDirEntry('home')]);

      const browser = new FileBrowser(mockBundle.client);
      await browser.navigate('/');
      await browser.goUp();

      expect(browser.currentPath).toBe('/');
    });
  });

  describe('refresh', () => {
    it('reloads current directory entries', async () => {
      listings.set('/home', [makeEntry('file.txt')]);

      const browser = new FileBrowser(mockBundle.client);
      await browser.navigate('/home');
      expect(browser.currentEntries).toHaveLength(1);

      // Simulate a change in the listing
      listings.set('/home', [makeEntry('file.txt'), makeEntry('new.txt')]);

      const entries = await browser.refresh();
      expect(entries).toHaveLength(2);
      expect(browser.currentEntries).toHaveLength(2);
    });

    it('bypasses cache', async () => {
      listings.set('/home', [makeEntry('file.txt')]);

      const browser = new FileBrowser(mockBundle.client, { cacheTtlMs: 60000 });
      await browser.navigate('/home');

      // Update listing but cache is still warm
      listings.set('/home', [makeEntry('file.txt'), makeEntry('new.txt')]);

      // refresh should bypass the cache
      const entries = await browser.refresh();
      expect(entries).toHaveLength(2);
    });
  });

  describe('home', () => {
    it('navigates to home directory', async () => {
      listings.set('/home/testuser', [makeEntry('welcome.txt')]);

      const browser = new FileBrowser(mockBundle.client);
      const entries = await browser.home();

      expect(browser.currentPath).toBe('/home/testuser');
      expect(entries).toHaveLength(1);
      expect(mockBundle.realpathMock).toHaveBeenCalledWith('~');
    });
  });

  describe('cache', () => {
    it('cache hit returns cached entries', async () => {
      listings.set('/home', [makeEntry('file.txt')]);

      const browser = new FileBrowser(mockBundle.client, { cacheTtlMs: 60000 });
      await browser.navigate('/home');

      // Update listing but cache is still warm
      listings.set('/home', [makeEntry('file.txt'), makeEntry('new.txt')]);

      // Second navigate within TTL should return cached
      const entries = await browser.navigate('/home');
      expect(entries).toHaveLength(1); // Cached result
    });

    it('cache miss fetches fresh entries', async () => {
      listings.set('/home', [makeEntry('file.txt')]);

      const browser = new FileBrowser(mockBundle.client, { cacheTtlMs: 0 });
      await browser.navigate('/home');

      // Update listing and cache is expired (TTL=0)
      listings.set('/home', [makeEntry('file.txt'), makeEntry('new.txt')]);

      const entries = await browser.navigate('/home');
      expect(entries).toHaveLength(2); // Fresh result
    });
  });
});

describe('file browser helpers', () => {
  it('prefers explicit paths over active pane cwd for start directories', () => {
    expect(resolveFileBrowserStartDirectory({
      path: '/home/alice/project',
      cwd: '/tmp/active',
    })).toBe('/home/alice/project');
  });

  it('uses active pane cwd when no explicit path is provided', () => {
    expect(resolveFileBrowserStartDirectory({ cwd: '/tmp/active' })).toBe('/tmp/active');
  });

  it('falls back to home when no path or cwd is available', () => {
    expect(resolveFileBrowserStartDirectory()).toBe('~');
  });

  it('builds SFTP URI parts for VS Code remote file opening', () => {
    expect(remoteFileUriParts(7, '/home/alice/file with spaces.txt')).toEqual({
      scheme: 'pocketshell',
      authority: '7',
      path: '/home/alice/file with spaces.txt',
    });
  });

  it('requires absolute remote file paths for SFTP URIs', () => {
    expect(() => remoteFileUriParts(7, 'relative.txt')).toThrow(/absolute/);
  });
});
