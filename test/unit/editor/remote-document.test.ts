/**
 * Unit tests for RemoteDocument.
 */

import { describe, it, expect } from 'vitest';
import { RemoteDocument } from '../../../src/editor/remote-document';
import type { RemoteFileMetadata } from '../../../src/editor/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(overrides?: Partial<RemoteFileMetadata>): RemoteFileMetadata {
  return {
    path: '/home/user/example.ts',
    size: 100,
    modifiedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteDocument', () => {
  describe('constructor', () => {
    it('sets initial state correctly', () => {
      const meta = makeMetadata();
      const doc = new RemoteDocument('/home/user/example.ts', 'hello world', meta);

      expect(doc.path).toBe('/home/user/example.ts');
      expect(doc.content).toBe('hello world');
      expect(doc.originalContent).toBe('hello world');
      expect(doc.isDirty).toBe(false);
      expect(doc.encoding).toBe('utf-8');
      expect(doc.version).toBe(1);
    });

    it('detects language from file extension', () => {
      const meta = makeMetadata({ path: '/home/user/script.py' });
      const doc = new RemoteDocument('/home/user/script.py', 'print("hi")', meta);
      expect(doc.language).toBe('python');
    });

    it('detects language from .ts extension', () => {
      const meta = makeMetadata();
      const doc = new RemoteDocument('/home/user/example.ts', 'const x = 1;', meta);
      expect(doc.language).toBe('typescript');
    });
  });

  describe('updateContent', () => {
    it('marks document as dirty when content changes', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());

      doc.updateContent('modified');

      expect(doc.content).toBe('modified');
      expect(doc.isDirty).toBe(true);
    });

    it('does not mark dirty when content is unchanged', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());

      doc.updateContent('original');

      expect(doc.isDirty).toBe(false);
    });

    it('increments version on content change', () => {
      const doc = new RemoteDocument('/a.txt', 'v1', makeMetadata());
      expect(doc.version).toBe(1);

      doc.updateContent('v2');
      expect(doc.version).toBe(2);

      doc.updateContent('v3');
      expect(doc.version).toBe(3);
    });

    it('does not increment version when content is unchanged', () => {
      const doc = new RemoteDocument('/a.txt', 'same', makeMetadata());
      const initialVersion = doc.version;

      doc.updateContent('same');

      expect(doc.version).toBe(initialVersion);
    });

    it('transitions from dirty back to clean if content reverts to original', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());

      doc.updateContent('changed');
      expect(doc.isDirty).toBe(true);

      doc.updateContent('original');
      expect(doc.isDirty).toBe(false);
    });
  });

  describe('markSaved', () => {
    it('clears the dirty flag', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());
      doc.updateContent('changed');
      expect(doc.isDirty).toBe(true);

      doc.markSaved();

      expect(doc.isDirty).toBe(false);
    });

    it('updates originalContent to current content', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());
      doc.updateContent('changed');

      doc.markSaved();

      expect(doc.originalContent).toBe('changed');
      expect(doc.content).toBe('changed');
    });

    it('keeps content and originalContent in sync after save', () => {
      const doc = new RemoteDocument('/a.txt', 'v1', makeMetadata());
      doc.updateContent('v2');
      doc.markSaved();

      // Modifying again should compare against the saved content
      doc.updateContent('v3');
      expect(doc.isDirty).toBe(true);

      doc.updateContent('v2');
      expect(doc.isDirty).toBe(false);
    });
  });

  describe('revert', () => {
    it('restores original content', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());
      doc.updateContent('changed');

      doc.revert();

      expect(doc.content).toBe('original');
      expect(doc.isDirty).toBe(false);
    });

    it('increments version on revert', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());
      doc.updateContent('changed');
      const versionBeforeRevert = doc.version;

      doc.revert();

      expect(doc.version).toBe(versionBeforeRevert + 1);
    });

    it('is a no-op when content matches original', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());
      const versionBefore = doc.version;

      doc.revert();

      expect(doc.version).toBe(versionBefore);
      expect(doc.isDirty).toBe(false);
    });
  });

  describe('events', () => {
    it('fires onDidChangeContent when content changes', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());
      const events: string[] = [];

      doc.onDidChangeContent.listen((content) => events.push(content));

      doc.updateContent('first');
      doc.updateContent('second');

      expect(events).toEqual(['first', 'second']);
    });

    it('does not fire onDidChangeContent when content is identical', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());
      const events: string[] = [];

      doc.onDidChangeContent.listen((content) => events.push(content));

      doc.updateContent('original');

      expect(events).toEqual([]);
    });

    it('fires onDidChangeDirty when becoming dirty', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());
      const events: boolean[] = [];

      doc.onDidChangeDirty.listen((isDirty) => events.push(isDirty));

      doc.updateContent('changed');

      expect(events).toEqual([true]);
    });

    it('fires onDidChangeDirty when becoming clean via updateContent', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());
      const events: boolean[] = [];

      doc.updateContent('changed');
      doc.onDidChangeDirty.listen((isDirty) => events.push(isDirty));

      doc.updateContent('original');

      expect(events).toEqual([false]);
    });

    it('fires onDidChangeDirty when markSaved is called', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());
      doc.updateContent('changed');

      const events: boolean[] = [];
      doc.onDidChangeDirty.listen((isDirty) => events.push(isDirty));

      doc.markSaved();

      expect(events).toEqual([false]);
    });

    it('does not fire onDidChangeDirty when markSaved on clean doc', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());

      const events: boolean[] = [];
      doc.onDidChangeDirty.listen((isDirty) => events.push(isDirty));

      doc.markSaved();

      expect(events).toEqual([]);
    });

    it('fires onDidChangeDirty when revert is called', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());
      doc.updateContent('changed');

      const events: boolean[] = [];
      doc.onDidChangeDirty.listen((isDirty) => events.push(isDirty));

      doc.revert();

      expect(events).toEqual([false]);
    });

    it('unsubscribe function stops events', () => {
      const doc = new RemoteDocument('/a.txt', 'original', makeMetadata());
      const events: string[] = [];

      const unsub = doc.onDidChangeContent.listen((content) => events.push(content));

      doc.updateContent('first');
      unsub();
      doc.updateContent('second');

      expect(events).toEqual(['first']);
    });
  });
});
