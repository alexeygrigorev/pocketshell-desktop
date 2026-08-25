import { describe, expect, it } from 'vitest';
import {
  decideClipboardPaste,
  isStageableClipboardType,
  normaliseClipboardType,
  type ClipboardSnapshot,
} from '../../src/shared/clipboardPaste';

/**
 * The DECISION behind Ctrl+V-in-the-terminal, enumerated.
 *
 * The delivery — cancelling the chord, reading the clipboard, calling into the
 * staging path — is pinned by terminalPasteChord.test.ts and by
 * composerClipboardPaste.test.ts. This file pins the part with all the cases in
 * it, which is precisely the part that cannot be reached through a real
 * clipboard in a test: jsdom has no `navigator.clipboard.read`, and building a
 * fake `ClipboardItem` per scenario would bury the scenario in scaffolding.
 *
 * The case that matters most is the last group. "Nothing usable on the
 * clipboard produces nothing on screen" is the rule a user notices when it is
 * broken — an empty composer that opened itself is worse than a keystroke that
 * did nothing, because now they have to close it.
 */

/** A snapshot with sensible defaults, so each test states only what it is about. */
function snapshot(over: Partial<ClipboardSnapshot> = {}): ClipboardSnapshot {
  return { items: [], text: null, ...over };
}

describe('decideClipboardPaste — images and files attach', () => {
  it('stages a screenshot, which is the whole reason this exists', () => {
    const action = decideClipboardPaste(snapshot({ items: [['image/png']] }));
    expect(action).toEqual({ kind: 'attach', picks: [{ item: 0, type: 'image/png' }] });
  });

  it('stages a PDF and an audio clip — attaching is not image-only', () => {
    // The mime table in src/main/attachments/mimeTypes.ts was extended for
    // exactly these two (4fded07). A decision that only recognised images would
    // have quietly made that extension unreachable from this entry point.
    for (const type of ['application/pdf', 'audio/mpeg', 'video/mp4']) {
      expect(decideClipboardPaste(snapshot({ items: [[type]] }))).toEqual({
        kind: 'attach',
        picks: [{ item: 0, type }],
      });
    }
  });

  it('prefers the IMAGE flavour when one item offers several', () => {
    // Order in `types` is the platform's choice, not a priority. The image is
    // the flavour that renders as a tile and that every agent can read.
    const action = decideClipboardPaste(
      snapshot({ items: [['application/pdf', 'text/html', 'image/png']] }),
    );
    expect(action).toEqual({ kind: 'attach', picks: [{ item: 0, type: 'image/png' }] });
  });

  it('takes one pick from EACH item, so a multi-file copy stages them all', () => {
    const action = decideClipboardPaste(
      snapshot({ items: [['image/png'], ['text/plain'], ['application/pdf']] }),
    );
    expect(action).toEqual({
      kind: 'attach',
      picks: [
        { item: 0, type: 'image/png' },
        { item: 2, type: 'application/pdf' },
      ],
    });
  });

  it('hands back the type string VERBATIM, parameters and all', () => {
    // `ClipboardItem.getType` matches exactly. Normalising for comparison is
    // this module's business; leaking the normalised form into the pick would
    // make the read fail on any platform that includes a charset.
    const action = decideClipboardPaste(snapshot({ items: [['IMAGE/PNG;charset=binary']] }));
    expect(action).toEqual({
      kind: 'attach',
      picks: [{ item: 0, type: 'IMAGE/PNG;charset=binary' }],
    });
  });

  it('beats text when both are present — one keystroke, one result', () => {
    // A copied screenshot almost always carries a text flavour too (a filename,
    // a URL). Staging the picture AND typing its filename would be two results
    // for one keypress. Same precedence `onPaste` applies to `clipboardData`.
    const action = decideClipboardPaste(
      snapshot({ items: [['image/png', 'text/plain']], text: 'shot.png' }),
    );
    expect(action).toEqual({ kind: 'attach', picks: [{ item: 0, type: 'image/png' }] });
  });
});

describe('decideClipboardPaste — text goes to the draft', () => {
  it('types plain text', () => {
    const action = decideClipboardPaste(snapshot({ items: [['text/plain']], text: 'ssh hetzner' }));
    expect(action).toEqual({ kind: 'draft', text: 'ssh hetzner' });
  });

  it('types a rich copy, because text/* never attaches', () => {
    // A copy out of a browser carries text/html alongside text/plain. HTML
    // markup as an uploaded file is nobody's intent; the plain text is what the
    // user can read and edit in the draft.
    const action = decideClipboardPaste(
      snapshot({ items: [['text/html', 'text/plain']], text: 'the readable version' }),
    );
    expect(action).toEqual({ kind: 'draft', text: 'the readable version' });
  });

  it('keeps newlines and every character — a paste is not a keystroke', () => {
    const text = 'line one\nline two\n\tindented';
    expect(decideClipboardPaste(snapshot({ text }))).toEqual({ kind: 'draft', text });
  });

  it('types whitespace, which IS content when it was explicitly asked for', () => {
    // Deliberately different from the composer's `isEmpty` guard, which treats
    // a whitespace draft as nothing worth keeping. That guard asks "may this
    // vanish silently"; this asks "did the user ask for something". They
    // pressed the key with spaces on the clipboard.
    expect(decideClipboardPaste(snapshot({ text: '   ' }))).toEqual({ kind: 'draft', text: '   ' });
  });

  it('works with no item listing at all — a refused read() still types', () => {
    // `navigator.clipboard.read()` needs a permission that `readText()` may
    // have and it may not. Losing images is acceptable; losing text because
    // the richer API was declined would not be.
    expect(decideClipboardPaste(snapshot({ items: [], text: 'still fine' }))).toEqual({
      kind: 'draft',
      text: 'still fine',
    });
  });
});

describe('decideClipboardPaste — nothing usable, nothing visible', () => {
  it('an empty clipboard does not open the composer', () => {
    expect(decideClipboardPaste(snapshot())).toEqual({ kind: 'none' });
  });

  it('an empty STRING is nothing, not a paste of nothing', () => {
    expect(decideClipboardPaste(snapshot({ items: [['text/plain']], text: '' }))).toEqual({
      kind: 'none',
    });
  });

  it('a text-only flavour with no readable text produces nothing', () => {
    // text/html and no text/plain: nothing to stage (text never stages) and
    // nothing to type. The composer must stay exactly as it was.
    expect(decideClipboardPaste(snapshot({ items: [['text/html']], text: null }))).toEqual({
      kind: 'none',
    });
  });

  it('rejects Chromium web custom formats, which are not mime types', () => {
    // Chromium exposes these as `web application/x-thing` — with a space. The
    // blob behind one is an opaque application payload no agent can read, and
    // the shape test is what rejects the whole class without enumerating it.
    expect(decideClipboardPaste(snapshot({ items: [['web application/x-thing']] }))).toEqual({
      kind: 'none',
    });
  });

  it('rejects a malformed type rather than trying to stage it', () => {
    for (const bad of ['', 'image', 'image/', '/png', 'image png']) {
      expect(isStageableClipboardType(bad)).toBe(false);
    }
  });

  it('an item carrying only unstageable types is skipped, not staged empty', () => {
    const action = decideClipboardPaste(
      snapshot({ items: [['text/html'], ['image/png']], text: null }),
    );
    // Item 0 contributes no pick at all; item 1 keeps its own index, because
    // the caller looks the ClipboardItem back up by that number.
    expect(action).toEqual({ kind: 'attach', picks: [{ item: 1, type: 'image/png' }] });
  });
});

describe('type normalisation', () => {
  it('drops parameters, case and surrounding space', () => {
    expect(normaliseClipboardType(' Image/PNG ; charset=binary')).toBe('image/png');
  });

  it('accepts the awkward but legal subtypes', () => {
    expect(isStageableClipboardType('image/svg+xml')).toBe(true);
    expect(isStageableClipboardType('application/vnd.oasis.opendocument.text')).toBe(true);
    expect(isStageableClipboardType('application/x-7z-compressed')).toBe(true);
  });

  it('still refuses text/*, however it is spelled', () => {
    expect(isStageableClipboardType('TEXT/Plain')).toBe(false);
    expect(isStageableClipboardType('text/markdown;charset=utf-8')).toBe(false);
  });
});
