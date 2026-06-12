/**
 * Unit tests for DocumentManager.
 */

import { describe, it, expect } from 'vitest';
import { DocumentManager } from '../../../src/editor/document-manager';
import type { RemoteFileMetadata } from '../../../src/editor/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(overrides?: Partial<RemoteFileMetadata>): RemoteFileMetadata {
  return {
    path: '/home/user/file.txt',
    size: 50,
    modifiedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DocumentManager', () => {
  describe('openDocument', () => {
    it('opens and retrieves a document', () => {
      const mgr = new DocumentManager();
      const meta = makeMetadata({ path: '/home/user/file.txt' });

      const doc = mgr.openDocument('/home/user/file.txt', 'hello', meta);

      expect(doc).toBeDefined();
      expect(doc.path).toBe('/home/user/file.txt');
      expect(doc.content).toBe('hello');
      expect(mgr.getDocument('/home/user/file.txt')).toBe(doc);
    });

    it('throws when opening a duplicate path', () => {
      const mgr = new DocumentManager();
      const meta = makeMetadata({ path: '/home/user/file.txt' });

      mgr.openDocument('/home/user/file.txt', 'first', meta);

      expect(() => {
        mgr.openDocument('/home/user/file.txt', 'second', meta);
      }).toThrow('Document already open');
    });

    it('fires onDidOpen event', () => {
      const mgr = new DocumentManager();
      const meta = makeMetadata({ path: '/home/user/file.txt' });
      const opened: string[] = [];

      mgr.onDidOpen.listen((doc) => opened.push(doc.path));

      mgr.openDocument('/home/user/file.txt', 'content', meta);

      expect(opened).toEqual(['/home/user/file.txt']);
    });
  });

  describe('getDocument', () => {
    it('returns undefined for unknown path', () => {
      const mgr = new DocumentManager();
      expect(mgr.getDocument('/nonexistent')).toBeUndefined();
    });
  });

  describe('closeDocument', () => {
    it('removes the document', () => {
      const mgr = new DocumentManager();
      const meta = makeMetadata({ path: '/home/user/file.txt' });

      mgr.openDocument('/home/user/file.txt', 'hello', meta);
      mgr.closeDocument('/home/user/file.txt');

      expect(mgr.getDocument('/home/user/file.txt')).toBeUndefined();
    });

    it('is a no-op for unknown paths', () => {
      const mgr = new DocumentManager();
      // Should not throw
      mgr.closeDocument('/nonexistent');
    });

    it('fires onDidClose event', () => {
      const mgr = new DocumentManager();
      const meta = makeMetadata({ path: '/home/user/file.txt' });
      const closed: string[] = [];

      mgr.onDidClose.listen((path) => closed.push(path));

      mgr.openDocument('/home/user/file.txt', 'content', meta);
      mgr.closeDocument('/home/user/file.txt');

      expect(closed).toEqual(['/home/user/file.txt']);
    });

    it('allows re-opening after close', () => {
      const mgr = new DocumentManager();
      const meta = makeMetadata({ path: '/home/user/file.txt' });

      mgr.openDocument('/home/user/file.txt', 'first', meta);
      mgr.closeDocument('/home/user/file.txt');
      const doc2 = mgr.openDocument('/home/user/file.txt', 'second', meta);

      expect(doc2.content).toBe('second');
    });
  });

  describe('listOpenDocuments', () => {
    it('returns empty array when no documents are open', () => {
      const mgr = new DocumentManager();
      expect(mgr.listOpenDocuments()).toEqual([]);
    });

    it('returns all open documents', () => {
      const mgr = new DocumentManager();

      mgr.openDocument('/a.txt', 'a', makeMetadata({ path: '/a.txt' }));
      mgr.openDocument('/b.txt', 'b', makeMetadata({ path: '/b.txt' }));
      mgr.openDocument('/c.txt', 'c', makeMetadata({ path: '/c.txt' }));

      const docs = mgr.listOpenDocuments();
      const paths = docs.map((d) => d.path).sort();

      expect(paths).toEqual(['/a.txt', '/b.txt', '/c.txt']);
    });
  });

  describe('getDirtyDocuments', () => {
    it('returns only documents with unsaved changes', () => {
      const mgr = new DocumentManager();

      const docA = mgr.openDocument('/a.txt', 'a', makeMetadata({ path: '/a.txt' }));
      mgr.openDocument('/b.txt', 'b', makeMetadata({ path: '/b.txt' }));
      const docC = mgr.openDocument('/c.txt', 'c', makeMetadata({ path: '/c.txt' }));

      docA.updateContent('a-modified');
      docC.updateContent('c-modified');

      const dirty = mgr.getDirtyDocuments();
      const paths = dirty.map((d) => d.path).sort();

      expect(paths).toEqual(['/a.txt', '/c.txt']);
    });
  });

  describe('onDidChangeDirty forwarding', () => {
    it('fires onDidChangeDirty when a document becomes dirty', () => {
      const mgr = new DocumentManager();
      const meta = makeMetadata({ path: '/home/user/file.txt' });
      const changes: { path: string; isDirty: boolean }[] = [];

      mgr.onDidChangeDirty.listen((e) => changes.push(e));

      const doc = mgr.openDocument('/home/user/file.txt', 'original', meta);
      doc.updateContent('modified');

      expect(changes).toEqual([
        { path: '/home/user/file.txt', isDirty: true },
      ]);
    });

    it('stops forwarding after document is closed', () => {
      const mgr = new DocumentManager();
      const meta = makeMetadata({ path: '/home/user/file.txt' });
      const changes: { path: string; isDirty: boolean }[] = [];

      mgr.onDidChangeDirty.listen((e) => changes.push(e));

      const doc = mgr.openDocument('/home/user/file.txt', 'original', meta);
      mgr.closeDocument('/home/user/file.txt');

      // This should not trigger the manager's event (doc is removed)
      doc.updateContent('modified');

      expect(changes).toEqual([]);
    });
  });

  describe('closeAll', () => {
    it('closes all open documents', () => {
      const mgr = new DocumentManager();

      mgr.openDocument('/a.txt', 'a', makeMetadata({ path: '/a.txt' }));
      mgr.openDocument('/b.txt', 'b', makeMetadata({ path: '/b.txt' }));

      mgr.closeAll();

      expect(mgr.listOpenDocuments()).toEqual([]);
      expect(mgr.getDocument('/a.txt')).toBeUndefined();
      expect(mgr.getDocument('/b.txt')).toBeUndefined();
    });

    it('fires onDidClose for each document', () => {
      const mgr = new DocumentManager();
      const closed: string[] = [];

      mgr.onDidClose.listen((path) => closed.push(path));

      mgr.openDocument('/a.txt', 'a', makeMetadata({ path: '/a.txt' }));
      mgr.openDocument('/b.txt', 'b', makeMetadata({ path: '/b.txt' }));

      mgr.closeAll();

      expect(closed.sort()).toEqual(['/a.txt', '/b.txt']);
    });
  });
});
