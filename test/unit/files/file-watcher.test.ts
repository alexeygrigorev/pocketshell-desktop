/**
 * Unit tests for RemoteFileWatcher.
 *
 * Uses fake timers to test polling behavior and mocked SftpClient
 * to simulate directory listing changes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteFileWatcher } from '../../../src/files/file-watcher';
import type { SftpClient } from '../../../src/files/sftp-client';
import type { RemoteFileEntry } from '../../../src/files/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(name: string, size = 100, modifiedAt = Date.now()): RemoteFileEntry {
  return {
    name,
    path: `/watch/${name}`,
    isDirectory: false,
    isFile: true,
    isSymbolicLink: false,
    size,
    modifiedAt,
  };
}

function createMockSftpClient(): {
  client: SftpClient;
  readdirMock: ReturnType<typeof vi.fn>;
} {
  const readdirMock = vi.fn();
  const client = { readdir: readdirMock } as unknown as SftpClient;
  return { client, readdirMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteFileWatcher', () => {
  let mockBundle: ReturnType<typeof createMockSftpClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockBundle = createMockSftpClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('watch', () => {
    it('polls for changes', async () => {
      const entries1 = [makeEntry('file.txt', 100)];
      const entries2 = [makeEntry('file.txt', 200)]; // size changed

      let callCount = 0;
      mockBundle.readdirMock.mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? entries1 : entries2;
      });

      const watcher = new RemoteFileWatcher(mockBundle.client, { interval: 2000 });
      const changes: string[] = [];
      watcher.onChange((path) => changes.push(path));

      await watcher.watch('/watch');

      // Initial read
      expect(callCount).toBe(1);
      expect(changes).toHaveLength(0);

      // Advance past first poll interval
      await vi.advanceTimersByTimeAsync(2000);
      expect(callCount).toBe(2);
      expect(changes).toEqual(['/watch']);
    });

    it('does not fire onChange when listing is unchanged', async () => {
      const entries = [makeEntry('file.txt', 100)];
      mockBundle.readdirMock.mockResolvedValue([...entries]);

      const watcher = new RemoteFileWatcher(mockBundle.client, { interval: 2000 });
      const changes: string[] = [];
      watcher.onChange((path) => changes.push(path));

      await watcher.watch('/watch');

      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);

      expect(changes).toHaveLength(0);
    });

    it('detects new files', async () => {
      const entries1 = [makeEntry('a.txt')];
      const entries2 = [makeEntry('a.txt'), makeEntry('b.txt')];

      let callCount = 0;
      mockBundle.readdirMock.mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? entries1 : entries2;
      });

      const watcher = new RemoteFileWatcher(mockBundle.client, { interval: 2000 });
      const changes: string[] = [];
      watcher.onChange((path) => changes.push(path));

      await watcher.watch('/watch');
      await vi.advanceTimersByTimeAsync(2000);

      expect(changes).toEqual(['/watch']);
    });

    it('detects removed files', async () => {
      const entries1 = [makeEntry('a.txt'), makeEntry('b.txt')];
      const entries2 = [makeEntry('a.txt')];

      let callCount = 0;
      mockBundle.readdirMock.mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? entries1 : entries2;
      });

      const watcher = new RemoteFileWatcher(mockBundle.client, { interval: 2000 });
      const changes: string[] = [];
      watcher.onChange((path) => changes.push(path));

      await watcher.watch('/watch');
      await vi.advanceTimersByTimeAsync(2000);

      expect(changes).toEqual(['/watch']);
    });
  });

  describe('unwatch', () => {
    it('stops polling', async () => {
      const entries = [makeEntry('file.txt')];
      mockBundle.readdirMock.mockResolvedValue([...entries]);

      const watcher = new RemoteFileWatcher(mockBundle.client, { interval: 2000 });

      await watcher.watch('/watch');
      watcher.unwatch('/watch');

      const readCountBefore = mockBundle.readdirMock.mock.calls.length;

      await vi.advanceTimersByTimeAsync(5000);

      // No additional calls after unwatch
      expect(mockBundle.readdirMock.mock.calls.length).toBe(readCountBefore);
    });
  });

  describe('onChange', () => {
    it('fires onChange when listing differs', async () => {
      const entries1 = [makeEntry('file.txt', 100)];
      const entries2 = [makeEntry('file.txt', 200)];

      let callCount = 0;
      mockBundle.readdirMock.mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? entries1 : entries2;
      });

      const watcher = new RemoteFileWatcher(mockBundle.client, { interval: 1000 });
      const changes: string[] = [];
      const unsub = watcher.onChange((path) => changes.push(path));

      await watcher.watch('/watch');
      await vi.advanceTimersByTimeAsync(1000);

      expect(changes).toEqual(['/watch']);

      // Unsubscribe
      unsub();

      // Change again
      mockBundle.readdirMock.mockResolvedValue([makeEntry('file.txt', 300)]);
      await vi.advanceTimersByTimeAsync(1000);

      // Should not get another event
      expect(changes).toEqual(['/watch']);
    });
  });

  describe('unwatchAll', () => {
    it('stops all watches', async () => {
      mockBundle.readdirMock.mockResolvedValue([makeEntry('file.txt')]);

      const watcher = new RemoteFileWatcher(mockBundle.client, { interval: 2000 });

      await watcher.watch('/a');
      await watcher.watch('/b');
      watcher.unwatchAll();

      const readCountBefore = mockBundle.readdirMock.mock.calls.length;

      await vi.advanceTimersByTimeAsync(5000);

      expect(mockBundle.readdirMock.mock.calls.length).toBe(readCountBefore);
    });
  });

  describe('poll error handling', () => {
    it('skips poll cycle on read error', async () => {
      // Use fixed timestamp so entries from different calls are identical
      const fixedTime = 1700000000000;
      const fixedEntries = [makeEntry('file.txt', 100, fixedTime)];

      let callCount = 0;
      mockBundle.readdirMock.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error('Temporary failure');
        return fixedEntries;
      });

      const watcher = new RemoteFileWatcher(mockBundle.client, { interval: 1000 });
      const changes: string[] = [];
      watcher.onChange((path) => changes.push(path));

      await watcher.watch('/watch');

      // First poll: readdir fails, no change fired
      await vi.advanceTimersByTimeAsync(1000);
      expect(changes).toHaveLength(0);

      // Second poll: success, still no change (same listing)
      await vi.advanceTimersByTimeAsync(1000);
      expect(changes).toHaveLength(0);
    });

    it('handles initial read failure gracefully', async () => {
      mockBundle.readdirMock.mockRejectedValue(new Error('Not available'));

      const watcher = new RemoteFileWatcher(mockBundle.client, { interval: 1000 });

      // Should not throw
      await watcher.watch('/watch');

      // Subsequent polls should still work
      mockBundle.readdirMock.mockResolvedValue([makeEntry('file.txt')]);
      await vi.advanceTimersByTimeAsync(1000);
    });
  });
});
