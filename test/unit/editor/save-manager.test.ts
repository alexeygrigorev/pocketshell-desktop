/**
 * Unit tests for RemoteSaveManager.
 *
 * Uses a mocked SftpAdapter to test save logic without a real server.
 */

import { describe, it, expect, vi } from 'vitest';
import { RemoteSaveManager } from '../../../src/editor/save-manager';
import { RemoteDocument } from '../../../src/editor/remote-document';
import type { RemoteFileMetadata, SftpAdapter, RemoteDocumentSaveResult } from '../../../src/editor/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(overrides?: Partial<RemoteFileMetadata>): RemoteFileMetadata {
  return {
    path: '/home/user/file.txt',
    size: 10,
    modifiedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Create a mock SftpAdapter with jest/vitest spies. */
function createMockAdapter(overrides?: Partial<SftpAdapter>): SftpAdapter {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({
      modifiedAt: 1_700_000_000_000,
      size: 10,
    }),
    readFileText: vi.fn().mockResolvedValue(''),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteSaveManager', () => {
  describe('save', () => {
    it('writes content via SFTP adapter', async () => {
      const adapter = createMockAdapter();
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata();
      const doc = new RemoteDocument('/home/user/file.txt', 'hello world', meta);
      doc.updateContent('hello world modified');

      const result = await mgr.save(doc);

      expect(result.success).toBe(true);
      expect(adapter.writeFile).toHaveBeenCalledWith('/home/user/file.txt', 'hello world modified');
    });

    it('clears the dirty flag on successful save', async () => {
      const adapter = createMockAdapter();
      const mgr = new RemoteSaveManager(adapter);
      const doc = new RemoteDocument('/home/user/file.txt', 'original', makeMetadata());

      doc.updateContent('modified');
      expect(doc.isDirty).toBe(true);

      await mgr.save(doc);

      expect(doc.isDirty).toBe(false);
      expect(doc.originalContent).toBe('modified');
    });

    it('returns error for read-only files', async () => {
      const adapter = createMockAdapter();
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata({ isReadOnly: true });
      const doc = new RemoteDocument('/home/user/readonly.txt', 'content', meta);
      doc.updateContent('changed');

      const result = await mgr.save(doc);

      expect(result.success).toBe(false);
      expect(result.error).toContain('read-only');
      expect(adapter.writeFile).not.toHaveBeenCalled();
    });

    it('detects conflict when remote mtime differs', async () => {
      const originalMtime = 1_700_000_000_000;
      const remoteMtime = 1_700_000_100_000; // Modified by someone else

      const adapter = createMockAdapter({
        stat: vi.fn().mockResolvedValue({ modifiedAt: remoteMtime, size: 20 }),
      });
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata({ modifiedAt: originalMtime });
      const doc = new RemoteDocument('/home/user/file.txt', 'content', meta);
      doc.updateContent('changed');

      const result = await mgr.save(doc);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Conflict');
      expect(adapter.writeFile).not.toHaveBeenCalled();
    });

    it('succeeds when remote mtime matches', async () => {
      const mtime = 1_700_000_000_000;

      const adapter = createMockAdapter({
        stat: vi.fn().mockResolvedValue({ modifiedAt: mtime, size: 10 }),
      });
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata({ modifiedAt: mtime });
      const doc = new RemoteDocument('/home/user/file.txt', 'content', meta);
      doc.updateContent('changed');

      const result = await mgr.save(doc);

      expect(result.success).toBe(true);
    });

    it('returns error when SFTP write fails', async () => {
      const adapter = createMockAdapter({
        writeFile: vi.fn().mockRejectedValue(new Error('Permission denied')),
      });
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata();
      const doc = new RemoteDocument('/home/user/file.txt', 'content', meta);
      doc.updateContent('changed');

      const result = await mgr.save(doc);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

    it('includes newSize in result when post-save stat succeeds', async () => {
      const mtime = 1_700_000_000_000;
      const adapter = createMockAdapter({
        stat: vi.fn()
          .mockResolvedValueOnce({ modifiedAt: mtime, size: 10 })
          .mockResolvedValueOnce({ modifiedAt: mtime + 1, size: 25 }),
      });
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata({ modifiedAt: mtime });
      const doc = new RemoteDocument('/home/user/file.txt', 'content', meta);
      doc.updateContent('changed');

      const result = await mgr.save(doc);

      expect(result.success).toBe(true);
      expect(result.newSize).toBe(25);
    });

    it('succeeds even when post-save stat fails', async () => {
      const mtime = 1_700_000_000_000;
      const adapter = createMockAdapter({
        stat: vi.fn()
          .mockResolvedValueOnce({ modifiedAt: mtime, size: 10 })
          .mockRejectedValueOnce(new Error('stat failed')),
      });
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata({ modifiedAt: mtime });
      const doc = new RemoteDocument('/home/user/file.txt', 'content', meta);
      doc.updateContent('changed');

      const result = await mgr.save(doc);

      expect(result.success).toBe(true);
      expect(result.newSize).toBeUndefined();
    });

    it('fires onDidSave event on successful save', async () => {
      const adapter = createMockAdapter();
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata();
      const doc = new RemoteDocument('/home/user/file.txt', 'content', meta);
      doc.updateContent('changed');

      const saved: string[] = [];
      mgr.onDidSave.listen((path) => saved.push(path));

      await mgr.save(doc);

      expect(saved).toEqual(['/home/user/file.txt']);
    });

    it('does not fire onDidSave event on failed save', async () => {
      const adapter = createMockAdapter({
        writeFile: vi.fn().mockRejectedValue(new Error('fail')),
      });
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata();
      const doc = new RemoteDocument('/home/user/file.txt', 'content', meta);
      doc.updateContent('changed');

      const saved: string[] = [];
      mgr.onDidSave.listen((path) => saved.push(path));

      await mgr.save(doc);

      expect(saved).toEqual([]);
    });
  });

  describe('saveAs', () => {
    it('writes to the new path via SFTP adapter', async () => {
      const adapter = createMockAdapter();
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata();
      const doc = new RemoteDocument('/home/user/file.txt', 'content', meta);

      const result = await mgr.saveAs(doc, '/home/user/file_copy.txt');

      expect(result.success).toBe(true);
      expect(adapter.writeFile).toHaveBeenCalledWith('/home/user/file_copy.txt', 'content');
    });

    it('clears the dirty flag', async () => {
      const adapter = createMockAdapter();
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata();
      const doc = new RemoteDocument('/home/user/file.txt', 'original', meta);
      doc.updateContent('changed');

      await mgr.saveAs(doc, '/home/user/new.txt');

      expect(doc.isDirty).toBe(false);
    });

    it('returns error when SFTP write fails', async () => {
      const adapter = createMockAdapter({
        writeFile: vi.fn().mockRejectedValue(new Error('No space')),
      });
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata();
      const doc = new RemoteDocument('/home/user/file.txt', 'content', meta);

      const result = await mgr.saveAs(doc, '/home/user/new.txt');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No space');
    });

    it('fires onDidSave with the new path', async () => {
      const adapter = createMockAdapter();
      const mgr = new RemoteSaveManager(adapter);
      const meta = makeMetadata();
      const doc = new RemoteDocument('/home/user/file.txt', 'content', meta);

      const saved: string[] = [];
      mgr.onDidSave.listen((path) => saved.push(path));

      await mgr.saveAs(doc, '/home/user/new.txt');

      expect(saved).toEqual(['/home/user/new.txt']);
    });
  });

  describe('saveAll', () => {
    it('saves multiple documents', async () => {
      const adapter = createMockAdapter();
      const mgr = new RemoteSaveManager(adapter);

      const metaA = makeMetadata({ path: '/a.txt' });
      const metaB = makeMetadata({ path: '/b.txt' });
      const docA = new RemoteDocument('/a.txt', 'content-a', metaA);
      const docB = new RemoteDocument('/b.txt', 'content-b', metaB);
      docA.updateContent('modified-a');
      docB.updateContent('modified-b');

      const results = await mgr.saveAll([docA, docB]);

      expect(results.get('/a.txt')?.success).toBe(true);
      expect(results.get('/b.txt')?.success).toBe(true);
      expect(adapter.writeFile).toHaveBeenCalledWith('/a.txt', 'modified-a');
      expect(adapter.writeFile).toHaveBeenCalledWith('/b.txt', 'modified-b');
    });

    it('handles partial failures', async () => {
      const adapter = createMockAdapter({
        writeFile: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('write error')),
      });
      const mgr = new RemoteSaveManager(adapter);

      const metaA = makeMetadata({ path: '/a.txt' });
      const metaB = makeMetadata({ path: '/b.txt' });
      const docA = new RemoteDocument('/a.txt', 'content-a', metaA);
      const docB = new RemoteDocument('/b.txt', 'content-b', metaB);
      docA.updateContent('modified-a');
      docB.updateContent('modified-b');

      const results = await mgr.saveAll([docA, docB]);

      expect(results.get('/a.txt')?.success).toBe(true);
      expect(results.get('/b.txt')?.success).toBe(false);
      expect(results.get('/b.txt')?.error).toContain('write error');
    });

    it('returns empty map for empty array', async () => {
      const adapter = createMockAdapter();
      const mgr = new RemoteSaveManager(adapter);

      const results = await mgr.saveAll([]);

      expect(results.size).toBe(0);
    });
  });
});
