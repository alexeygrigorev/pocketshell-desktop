import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Terminal } from '@xterm/xterm';

/**
 * The bridge between xterm's buffer and the path detector.
 *
 * What is actually under test is the COORDINATE mapping. The detector works on
 * a string and reports offsets; xterm underlines CELLS. A logical line can be
 * spread over several wrapped rows, and a double-width character occupies two
 * cells while contributing one string index — so an off-by-one here underlines
 * the wrong run of characters, which looks exactly like a broken detector while
 * being nothing of the sort.
 *
 * The terminal is faked rather than instantiated: a real `Terminal` needs a DOM
 * and a renderer to have any buffer contents at all, and none of that would add
 * anything to the arithmetic being checked.
 */

// The files store subscribes to HTML-preview asset counts as it is created,
// so the stub needs that surface even though nothing here opens a file.
vi.mock('../../src/renderer/ipc', () => ({
  api: { sftp: {}, preview: { onStats: () => () => undefined } },
}));

const { scanBufferLine, pathLinks } = await import('../../src/renderer/terminalLinks');
const { useFilesStore } = await import('../../src/renderer/stores/files');
const { useSessionsStore } = await import('../../src/renderer/stores/sessions');

/** One row of the fake buffer. `cells` is one entry per CELL, not per char. */
interface FakeRow {
  cells: { chars: string; width: number }[];
  isWrapped: boolean;
}

/**
 * Build a fake buffer from plain strings, one per row. A row is a continuation
 * of the previous one when it is listed in [wrapped].
 */
function fakeTerminal(rows: string[], wrapped: number[] = []): Terminal {
  const lines: FakeRow[] = rows.map((row, i) => ({
    cells: [...row].map((ch) => ({ chars: ch, width: 1 })),
    isWrapped: wrapped.includes(i),
  }));
  return buildTerminal(lines);
}

function buildTerminal(lines: FakeRow[]): Terminal {
  const buffer = {
    getNullCell: () => ({ getChars: () => '', getWidth: () => 1 }),
    getLine: (y: number) => {
      const line = lines[y];
      if (!line) return undefined;
      return {
        length: line.cells.length,
        isWrapped: line.isWrapped,
        getCell: (x: number) => {
          const cell = line.cells[x];
          if (!cell) return undefined;
          return { getChars: () => cell.chars, getWidth: () => cell.width };
        },
      };
    },
  };
  return { buffer: { active: buffer } } as unknown as Terminal;
}

/**
 * The event xterm would pass. Never read by `activate` — the tests run in the
 * node environment, where `MouseEvent` does not exist, and the handler under
 * test only ever uses the match it closed over.
 */
const CLICK = {} as MouseEvent;

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('scanBufferLine', () => {
  it('reads a single row as itself', () => {
    const term = fakeTerminal(['tmp/a.mp3: ok']);
    expect(scanBufferLine(term, 1).text).toBe('tmp/a.mp3: ok');
  });

  it('joins a wrapped continuation row onto the row it continues', () => {
    const term = fakeTerminal(['tmp/voice-p', 'reviews/a.mp3'], [1]);
    // Asked about EITHER row, the answer is the whole logical line: xterm calls
    // the provider with whichever row the mouse is over.
    expect(scanBufferLine(term, 1).text).toBe('tmp/voice-previews/a.mp3');
    expect(scanBufferLine(term, 2).text).toBe('tmp/voice-previews/a.mp3');
  });

  it('does not join a row that merely follows another', () => {
    const term = fakeTerminal(['tmp/a.mp3', 'tmp/b.mp3']);
    expect(scanBufferLine(term, 1).text).toBe('tmp/a.mp3');
  });

  it('reads an untouched cell as a space, so tokens still break', () => {
    const term = buildTerminal([
      {
        cells: [
          { chars: 'a', width: 1 },
          { chars: '', width: 1 },
          { chars: 'b', width: 1 },
        ],
        isWrapped: false,
      },
    ]);
    expect(scanBufferLine(term, 1).text).toBe('a b');
  });

  it('gives a double-width character one string index and its own cell', () => {
    const term = buildTerminal([
      {
        cells: [
          { chars: '漢', width: 2 },
          // xterm stores the right half as an empty cell of width 0.
          { chars: '', width: 0 },
          { chars: 'x', width: 1 },
        ],
        isWrapped: false,
      },
    ]);
    const scanned = scanBufferLine(term, 1);
    expect(scanned.text).toBe('漢x');
    expect(scanned.cells).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
    ]);
  });
});

describe('pathLinks', () => {
  const context = (): { sessionName: string } => ({ sessionName: 'git-foo' });

  it('spans exactly the cells of the path, and no further', () => {
    const term = fakeTerminal(['wrote tmp/a.mp3: ok']);
    const links = pathLinks(term, 1, context);

    expect(links).toHaveLength(1);
    // 1-based and inclusive at both ends: `tmp/a.mp3` starts at column 7 and
    // ends at column 15, leaving the colon undecorated.
    expect(links[0]?.range).toEqual({ start: { x: 7, y: 1 }, end: { x: 15, y: 1 } });
    expect(links[0]?.text).toBe('tmp/a.mp3');
  });

  it('spans two rows when the path is wrapped across them', () => {
    const term = fakeTerminal(['tmp/voice-p', 'reviews/a.mp3'], [1]);
    const links = pathLinks(term, 1, context);

    expect(links[0]?.range).toEqual({ start: { x: 1, y: 1 }, end: { x: 13, y: 2 } });
  });

  it('underlines the :line:col suffix but opens the path without it', () => {
    const term = fakeTerminal(['src/main.ts:12:5 warning']);
    const links = pathLinks(term, 1, context);

    expect(links[0]?.text).toBe('src/main.ts:12:5');

    const files = useFilesStore();
    const sessions = useSessionsStore();
    sessions.sessions = [
      { name: 'git-foo', created: 0, activity: 0, attached: true, path: '~/git/foo' },
    ];
    links[0]?.activate(CLICK, links[0].text);

    // Resolved against the SESSION's cwd, tilde already stripped, no `:12:5`.
    expect(files.reveal).toBe('git/foo/src/main.ts');
  });

  it('asks for pointer + underline, the same decoration the web links get', () => {
    const term = fakeTerminal(['tmp/a.mp3']);
    expect(pathLinks(term, 1, context)[0]?.decorations).toEqual({
      pointerCursor: true,
      underline: true,
    });
  });

  it('returns nothing for a line with no path in it', () => {
    const term = fakeTerminal(['duration=9.613042 and/or 2m 19s']);
    expect(pathLinks(term, 1, context)).toEqual([]);
  });

  it('falls back to home-relative when the session has no reported cwd', () => {
    const term = fakeTerminal(['tmp/a.mp3']);
    const files = useFilesStore();
    const sessions = useSessionsStore();
    sessions.sessions = [
      { name: 'git-foo', created: 0, activity: 0, attached: true, path: null },
    ];

    pathLinks(term, 1, context)[0]?.activate(CLICK, 'tmp/a.mp3');

    expect(files.reveal).toBe('tmp/a.mp3');
  });
});
