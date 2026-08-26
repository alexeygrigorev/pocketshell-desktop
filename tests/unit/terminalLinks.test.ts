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

/**
 * A fake buffer with a real WIDTH, for the rules that reconstruct a wrap xterm
 * never flagged.
 *
 * Every row of a real xterm buffer is `cols` cells long whether or not anything
 * was written to the far end of it, and both join rules read that geometry: one
 * asks whether the row above is full to its last column, the other whether the
 * next token could have fitted on it. `fakeTerminal` above pads nothing, so a
 * row there is as wide as its text and every row would look full — which is
 * exactly the mistake these tests exist to catch.
 */
function fakeScreen(rows: string[], width: number): Terminal {
  return buildTerminal(
    rows.map((row) => ({
      cells: [...row.padEnd(width, ' ')].map((ch) => ({ chars: ch, width: 1 })),
      isWrapped: false,
    })),
  );
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

/**
 * The two shapes the user reported, transcribed from their pane.
 *
 * Neither row is flagged `isWrapped`, because neither was wrapped BY xterm:
 * this pane is always a tmux client and the agent TUI inside it positions every
 * row it paints. The joining rules reconstruct the break from geometry instead.
 */
describe('scanBufferLine — a path a TUI broke across two rows', () => {
  const PNG =
    '/home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-62ab287b-39b5-461a-9d45-69e2eae3d41a.png';
  const TILDE_PNG =
    '~/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-de1a03f1-2d3f-4d2d-8a44-c5da743f849e.png';

  /** The Codex block: a wrapped command with `  │ ` in front of every continuation. */
  const GUTTER_ROWS = [
    'Ran for f in /home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/',
    '  │ exec-62ab287b-39b5-461a-9d45-69e2eae3d41a.png /home/alexey/.codex/',
    '  │ generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/',
  ];

  it('joins a gutter-marked continuation and drops the gutter itself', () => {
    const term = fakeScreen(GUTTER_ROWS, 100);
    expect(scanBufferLine(term, 1).text.trimEnd()).toBe(
      `Ran for f in ${PNG} /home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/`,
    );
  });

  it('gives the same logical line whichever of its rows the mouse is over', () => {
    const term = fakeScreen(GUTTER_ROWS, 100);
    const first = scanBufferLine(term, 1).text;
    expect(scanBufferLine(term, 2).text).toBe(first);
    expect(scanBufferLine(term, 3).text).toBe(first);
  });

  it('linkifies the split path, underlining from the first row into the second', () => {
    const term = fakeScreen(GUTTER_ROWS, 100);
    const links = pathLinks(term, 1, () => ({ sessionName: 'git-foo' }));

    expect(links.map((l) => l.text)).toEqual([
      PNG,
      '/home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/',
    ]);
    // 1-based and inclusive: the path starts at column 14 of row 1 and ends at
    // column 49 of row 2 — the gutter's four cells sit inside the underline
    // because an xterm range is a span of cells, which is equally true of the
    // wrapped web links this decoration was copied from.
    expect(links[0]?.range).toEqual({ start: { x: 14, y: 1 }, end: { x: 49, y: 2 } });
  });

  it('opens the whole path, not the directory the first row ended at', () => {
    const term = fakeScreen(GUTTER_ROWS, 100);
    const links = pathLinks(term, 1, () => ({ sessionName: 'git-foo' }));
    const files = useFilesStore();
    const sessions = useSessionsStore();
    sessions.sessions = [
      { name: 'git-foo', created: 0, activity: 0, attached: true, path: '~/git/foo' },
    ];

    links[0]?.activate(CLICK, links[0].text);
    // Absolute, so the session's cwd is ignored entirely — an image outside the
    // repo is as openable as one inside it.
    expect(files.reveal).toBe(PNG);
  });

  it('joins a hard wrap tmux repainted, where the break lands mid-token', () => {
    // The "Viewed Image" case. The row is full to its last column, so the TUI
    // ran out of room mid-UUID and continued at column 0.
    const first = '    └ ~/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-de1a03f1-2d3f-';
    const term = fakeScreen([first, '4d2d-8a44-c5da743f849e.png'], first.length);

    expect(scanBufferLine(term, 1).text.trimEnd()).toBe(`    └ ${TILDE_PNG}`);
    expect(pathLinks(term, 2, () => ({ sessionName: 'git-foo' }))[0]?.text).toBe(TILDE_PNG);
  });

  it('opens the tilde form without anyone expanding $HOME', () => {
    const first = '    └ ~/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-de1a03f1-2d3f-';
    const term = fakeScreen([first, '4d2d-8a44-c5da743f849e.png'], first.length);
    const links = pathLinks(term, 1, () => ({ sessionName: 'git-foo' }));
    const files = useFilesStore();

    links[0]?.activate(CLICK, links[0].text);
    // `stripTilde` drops the `~/` and leaves a path relative to the SFTP root,
    // which IS the login home. No host lookup, one round trip, and nothing to
    // get wrong when `$HOME` has not been reported.
    expect(files.reveal).toBe(
      '.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-de1a03f1-2d3f-4d2d-8a44-c5da743f849e.png',
    );
  });
});

/**
 * The other half of the joining rules, and the half that decides whether this
 * feature is trustworthy: two rows that merely follow one another must stay two
 * lines. A join that should not have happened invents a path nothing can open
 * and drags an underline through text the remote program never meant to link.
 */
describe('scanBufferLine — rows that must NOT be joined', () => {
  const scan = (rows: string[], width: number): string =>
    scanBufferLine(fakeScreen(rows, width), 1).text.trimEnd();

  it('refuses a full row whose last token is not an anchored path', () => {
    // `and/` is the false-positive suite's own shape. A row can end in one and
    // be exactly as wide as the window; that is not evidence of anything.
    const first = 'the mount is configured read/write and/';
    expect(scan([first, 'or so the docs claim'], first.length)).toBe(first);
  });

  it('refuses two complete paths on consecutive rows', () => {
    // The row above stops well short of the margin, so nothing ran out of room
    // and there is no wrap to reconstruct. Joining these would produce
    // `/tmp/a.txt/tmp/b.txt`, a link to a file that cannot exist.
    expect(scan(['wrote /tmp/a.txt', '/tmp/b.txt is next'], 80)).toBe('wrote /tmp/a.txt');
  });

  it('refuses a gutter row whose first token would have fitted above', () => {
    // Both rows carry the block's gutter and the row above ends at a directory,
    // which is the exact shape rule 2 fires on — except that `done` had sixty
    // columns of room, so the row above did not end because it was full.
    expect(scan(['  │ created /tmp/out/', '  │ done'], 80)).toBe('  │ created /tmp/out/');
  });

  it('refuses a gutter row when the path above is already finished', () => {
    // No trailing slash: `/tmp/out` is a whole name, and gluing `done` onto it
    // would silently rename it.
    expect(scan(['  │ wrote /tmp/out', '  │ done and dusted'], 80)).toBe('  │ wrote /tmp/out');
  });

  it('refuses a gutter row that starts a path of its own', () => {
    expect(scan(['  │ cp /tmp/out/', '  │ /srv/media/b.mp3'], 80)).toBe('  │ cp /tmp/out/');
  });

  it('refuses an ASCII pipe, which is a table or a shell pipeline', () => {
    // Only box-drawing counts as a gutter. A markdown table's `| ` looks the
    // same to a naive rule and appears far more often.
    expect(scan(['| /tmp/out/', '| next.png    |'], 80)).toBe('| /tmp/out/');
  });

  it('still refuses to join when the row above is blank', () => {
    expect(scan(['', '  │ tmp/a.mp3'], 80)).toBe('');
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
