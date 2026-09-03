/**
 * The xterm side of "click a path in the terminal, land on it in the Files tab".
 *
 * Three jobs, in order:
 *   1. flatten a buffer line (with its wrapped continuation rows) back into a
 *      string, remembering which cell produced each character;
 *   2. run the pure detector over that string (./terminalPaths.ts);
 *   3. hand xterm an ILink per match, whose `activate` asks the files store to
 *      reveal the path.
 *
 * Step 1 is the only part that is not obvious. xterm has no "give me the
 * logical line" call: a line longer than the window is stored as several rows,
 * each flagged `isWrapped`, and a link's range is expressed in CELLS. So the
 * flattening keeps a parallel array of cell positions — one entry per UTF-16
 * code unit of the string — and the match offsets are mapped back through it.
 * Walking the cells (rather than using `translateToString` and doing
 * arithmetic) is what keeps the mapping right when a row contains a double-width
 * character, which occupies two cells but one string index.
 *
 * ## Why `isWrapped` is not enough, in THIS pane
 *
 * `isWrapped` is set when xterm itself ran out of columns — the writer kept
 * printing past the right margin and the terminal moved to the next row. That
 * is not how anything writes to this pane. The pane is always a tmux client and
 * tmux redraws row by row (`tty_cursor(tty, 0, y)` before each one), and the
 * agent TUIs inside it are full-screen renderers that position every cell they
 * paint. Neither ever lets a line overflow, so a line the USER sees broken
 * across two rows arrives here as two rows with `isWrapped` false on both — and
 * a path that spans the break is never seen whole by the detector.
 *
 * Three user reports are the shapes the rules below reconstruct:
 *
 *   - the Codex TUI wrapped mid-token and continued at column 0 of the next
 *     row, i.e. exactly the hard wrap xterm would have flagged had it done the
 *     wrapping (rule 1);
 *   - the Codex TUI wrapped its own block and prefixed the continuation with
 *     its box-drawing gutter (`  │ `), which has to be dropped as well as
 *     joined (rule 2);
 *   - this app's own CLI wraps long tokens at the hyphens inside them instead
 *     of at the margin, so the row above the break ends a few columns SHORT of
 *     full — `…/event-webinar-` / `og.png` — and rule 1b reads the hyphen as
 *     the break opportunity it is.
 *
 * Both rules are deliberately narrow, for the reason terminalPaths.ts's header
 * gives: joining two rows that were never one line can only invent a path that
 * does not exist, and an underline stretched across a boundary is the most
 * visible way this feature can look broken. Each condition is spelled out at
 * the rule.
 *
 * ## Appearance
 *
 * A path link is decorated exactly like the http links this terminal already
 * has: pointer cursor and an underline, both on hover only. That is not a
 * shrug — it is the whole decoration vocabulary xterm's link API offers
 * (`ILinkDecorations` is documented as "what to show when HOVERING"), and it is
 * the right vocabulary here anyway. Colouring a path would mean overriding a
 * colour the remote program chose, which is precisely what docs/DESIGN.md §3
 * protects by transcribing the Campbell palette rather than inventing one. The
 * underline inherits the cell's own foreground, so a path printed green
 * underlines green and the terminal keeps saying what the program said.
 *
 * Persistent highlighting — every path underlined at rest — would need
 * `Terminal.registerDecoration`, which anchors an overlay to a buffer MARKER.
 * Under tmux that is not viable: tmux repaints whole rows constantly and lives
 * on the alternate screen, so markers would decorate cells whose contents have
 * since changed, and every repaint would mean re-scanning the viewport.
 *
 * ## Clicking while the remote app owns the mouse
 *
 * This pane is ALWAYS a tmux client, and the agent TUIs it runs turn mouse
 * reporting on, so "does a link still fire when the remote program is grabbing
 * clicks?" decides whether any of this works in practice rather than only in a
 * bare shell. It does fire, and the reason is that the two mechanisms are bound
 * to different elements (xterm 6.0.0, verified against its sources):
 *
 *   - mouse REPORTING binds to `.xterm` — `CoreBrowserTerminal.bindMouse()`
 *     opens with `const el = this.element`;
 *   - the LINKIFIER binds to `.xterm-screen`, a child of it —
 *     `createInstance(Linkifier, this.screenElement)`.
 *
 * A click lands inside the screen, so the linkifier's own mousedown/mouseup run
 * first on the way up, and `Linkifier._handleMouseUp` calls `link.activate`
 * with no consultation of `areMouseEventsActive` anywhere along that path. The
 * outer handler's `cancel(ev)` calls `stopPropagation`, which only stops the
 * event travelling FURTHER up — it cannot un-run a listener on a descendant.
 * The decorations survive too: `.xterm.enable-mouse-events { cursor: default }`
 * is overridden by the later and equally specific `.xterm .xterm-cursor-pointer`
 * in xterm's own stylesheet.
 *
 * What the user ALSO gets is the same click delivered to the remote program, so
 * tmux may move its cursor or select the pane under the pointer on the way. The
 * conventional bypass suppresses that and leaves the link working: off macOS,
 * `SelectionService.shouldForceSelection` returns `event.shiftKey`, and
 * `bindMouse`'s mousedown handler returns before `sendEvent` when it is true.
 * So a plain click follows the link (and nudges the TUI), and Shift-click
 * follows it cleanly — the same modifier that already bypasses mouse reporting
 * for drag-selection in this pane.
 */
import type { IBuffer, IBufferCell, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { findPaths } from './terminalPaths';
import { useFilesStore } from './stores/files';
import { useSessionsStore } from './stores/sessions';

/**
 * What a click needs to know, read fresh on every call.
 *
 * A getter rather than a value because both facts move: the pane re-points at
 * another session without being re-created (see TerminalView's `showTarget`),
 * and the sessions store is refreshed lazily, so at mount time it may not yet
 * know the session's working directory at all.
 */
export interface TerminalPathContext {
  /** tmux session the pane is showing, or '' for a bare shell. */
  sessionName: string;
}

/**
 * Cap on how many rows one flattening may join. A pathological wrapped line
 * (a 9000-row scrollback of one string) must not turn a mouse-move into a
 * full-buffer walk; the same 2048-character budget WebLinkProvider uses.
 */
const MAX_SCAN_CHARS = 2048;

/**
 * Cap on rows joined by RECONSTRUCTION ({@link joinedRowSkip}), in each
 * direction. xterm's own `isWrapped` chain is left uncapped because it is a
 * fact the terminal recorded; a reconstruction is a guess, and a guess that
 * chained down a screenful of gutter-prefixed rows would spend a whole buffer
 * walk on a hover. Three rows is the longest either user report needed.
 */
const MAX_JOIN_ROWS = 8;

/**
 * How far short of the margin a row may end and still count as having been
 * wrapped (rule 1b in {@link joinedRowSkip}). Full-to-the-last-column stays
 * the strong evidence it always was; this admits the weaker shape where the
 * wrapper broke at a hyphen INSIDE the token and so left the row a few blank
 * columns short — five in the report this rule is built from. Eight covers
 * that with room for a slightly longer displaced fragment; the guards at the
 * rule (hyphen tail, head would not have fitted) are what keep the wider
 * window from gluing prose together, not the slack itself.
 */
const MAX_WRAP_SLACK = 8;

/**
 * The gutter a TUI puts in front of the continuation rows of a block it wrapped
 * itself — `  │ ` in the Codex output the user reported.
 *
 * Box-drawing only, and only with the single trailing space the TUIs actually
 * emit. ASCII `|` is deliberately NOT here: `| ` starts a markdown table row
 * and appears in the middle of shell pipelines, and admitting it would let this
 * rule glue together two rows of a table.
 */
const GUTTER = /^ {0,8}[│┃] /;

/**
 * A token that is unambiguously a path SO FAR: anchored by `/`, `~/`, `./` or
 * `../`.
 *
 * This is the load-bearing guard on both join rules. Everything the detector's
 * false-positive suite is built from — `and/or`, `client/server`, `w/o`, `y/N`,
 * `9/10` — is unanchored, so a row ending in one of them is never a row we will
 * glue anything onto. Joining is only ever done in service of a path, and only
 * when the row above already committed to being one.
 */
const ROOTED = /^(?:\/|~\/|\.\/|\.\.\/)/;

/** One flattened logical line, plus the cell each character came from. */
export interface ScannedLine {
  text: string;
  /** `cells[i]` is the 0-based buffer cell that produced `text[i]`. */
  cells: { x: number; y: number }[];
}

/** A row read for the join rules: its text and where its content actually ends. */
interface RowRead {
  /** The whole row, untouched cells read as spaces. Never trimmed. */
  text: string;
  /** Column of the last cell holding anything but a space, or -1 for a blank row. */
  lastCol: number;
  /** Cells in the row — which, in xterm, is the terminal's column count. */
  width: number;
}

/**
 * Read one row for the join rules only.
 *
 * Separate from the flattening loop because the rules need to look at a row
 * BEFORE deciding whether to consume it, and because they need a COLUMN
 * (`lastCol`) rather than a string offset — the two part company the moment the
 * row holds a double-width character, which is the same reason the flattening
 * walks cells instead of using `translateToString`.
 */
function readRow(buf: IBuffer, y: number, scratch: IBufferCell): RowRead | null {
  const line = buf.getLine(y);
  if (!line) return null;
  const parts: string[] = [];
  let lastCol = -1;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x, scratch);
    if (!cell || cell.getWidth() === 0) continue;
    const content = cell.getChars();
    if (content === '' || content === ' ') {
      parts.push(' ');
      continue;
    }
    parts.push(content);
    lastCol = x;
  }
  return { text: parts.join(''), lastCol, width: line.length };
}

/**
 * Does [next] continue [prev], even though xterm did not flag it wrapped?
 *
 * @returns how many leading CELLS of [next] to drop before joining (0 for a
 *   plain wrap, the gutter's width for a gutter-marked one), or null for "these
 *   are two different lines" — which is the answer this function is built to
 *   give, and gives for everything it is not certain about.
 */
function joinedRowSkip(prev: RowRead, next: RowRead): number | null {
  if (prev.lastCol < 0) return null;
  const tail = /\S+$/.exec(prev.text.trimEnd())?.[0] ?? '';
  if (!ROOTED.test(tail)) return null;
  // A URL belongs to WebLinksAddon and is never extended across a row break:
  // gluing a second row onto one would produce a link to a host nobody named.
  if (tail.includes('://')) return null;

  const gutter = GUTTER.exec(next.text);
  if (gutter === null) {
    const first = next.text.charAt(0);
    if (first === '' || first === ' ') return null;

    // RULE 1 — the hard wrap tmux repainted away.
    //
    // The evidence is geometric and it is the strongest available: the row
    // above is full to its very last column, so whoever wrote it had no room
    // left, and the row below starts at column 0 with a non-blank. That is the
    // exact situation in which xterm would have set `isWrapped` had the bytes
    // reached it as one overlong line instead of as two positioned rows.
    //
    // Not caught, deliberately: a row whose last column was left blank because
    // a double-width character would not fit in it. Reconstructing that needs a
    // second guess on top of this one, and the cost of being wrong is an
    // underline running through unrelated text.
    if (prev.lastCol === prev.width - 1) return 0;

    // RULE 1b — the hyphen wrap some TUIs prefer, this app's own CLI among
    // them: break long tokens at the hyphens inside them rather than at the
    // margin, which leaves the row above the break a few blank columns short
    // and rule 1 without its geometric evidence. Four guards, each the reason
    // a different way of being wrong stays shut:
    //
    //   - the row is still NEARLY full ({@link MAX_WRAP_SLACK}). A row that
    //     stopped halfway down is a paragraph, not a wrap.
    //   - the tail ends with `-`. That is the break opportunity a hyphen-
    //     wrapping wrapper used, and the one character whose presence at a
    //     row's end says the token was cut rather than finished: a whole path
    //     landing near the margin (`…/result.png` + `and cleaned up`) ends in
    //     something else and never gets here.
    //   - the continuation does not start with `/`. `…-` plus `/x` is not a
    //     path anyone wrote; it is two paths, and the second one is whole
    //     already.
    //   - the continuation's first token WOULD NOT HAVE FIT in the columns the
    //     row left free. That is the wrapper's own arithmetic run backwards,
    //     the same one rule 2 uses: if the token fit, the row above did not
    //     end because it ran out of room, so the row below is a new line.
    if (prev.width - 1 - prev.lastCol > MAX_WRAP_SLACK) return null;
    if (!tail.endsWith('-')) return null;
    const head = /^\S+/.exec(next.text)?.[0] ?? '';
    if (head === '' || head.startsWith('/')) return null;
    if (prev.lastCol + 1 + head.length <= prev.width) return null;
    return 0;
  }

  // RULE 2 — the TUI wrapped its own block and marked the continuation.
  //
  // Three conditions, each guarding a different way of being wrong:
  //
  //   - the tail ends with `/`. A TUI that wraps its own text breaks at a
  //     boundary it chose, and `…/` is the only break point that leaves the
  //     path visibly unfinished. Without this, `  │ wrote /tmp/out` followed by
  //     `  │ done` would join into `/tmp/outdone`.
  //   - the continuation does not itself start with `/`. `…/` plus `/x` is not
  //     a path anyone wrote; it is two paths, and the second one is whole
  //     already.
  //   - the continuation's first token WOULD NOT HAVE FIT on the row above.
  //     This is the wrapper's own arithmetic, run backwards: if the token fit,
  //     the row above did not end because it ran out of room, so the row below
  //     is a new line that merely happens to carry the same gutter. It is what
  //     stops `  │ created /tmp/out/` + `  │ done` from ever joining, since
  //     `done` had eighty columns of room to sit in.
  if (!tail.endsWith('/')) return null;
  const rest = next.text.slice(gutter[0].length);
  const head = /^\S+/.exec(rest)?.[0] ?? '';
  if (head === '' || head.startsWith('/')) return null;
  if (prev.lastCol + 1 + head.length <= prev.width) return null;
  // The gutter is spaces and a narrow box-drawing character, so its string
  // length is also its cell count — no double-width correction needed.
  return gutter[0].length;
}

/**
 * Flatten the logical line that [bufferLineNumber] (1-based, as xterm passes
 * it to a link provider) belongs to.
 */
export function scanBufferLine(term: Terminal, bufferLineNumber: number): ScannedLine {
  const buf = term.buffer.active;
  const chars: string[] = [];
  const cells: { x: number; y: number }[] = [];
  const scratch = buf.getNullCell();

  // Walk up to the row the logical line STARTS on. A row is a continuation of
  // the one above it when it is flagged wrapped, or when the rules above can
  // reconstruct a wrap xterm never saw; the first row that is neither is where
  // the line begins.
  let y = bufferLineNumber - 1;
  let joined = 0;
  while (y > 0) {
    const line = buf.getLine(y);
    if (line?.isWrapped) {
      y--;
      continue;
    }
    if (joined >= MAX_JOIN_ROWS) break;
    // Two extra row walks, and only on the row the mouse is actually over —
    // xterm asks a link provider once per hovered ROW, not once per cell.
    const above = readRow(buf, y - 1, scratch);
    const here = readRow(buf, y, scratch);
    if (above === null || here === null) break;
    if (joinedRowSkip(above, here) === null) break;
    joined++;
    y--;
  }

  // Cells to drop from the front of the row about to be read: a reconstructed
  // gutter, never anything else.
  let skip = 0;
  joined = 0;
  for (;;) {
    const line = buf.getLine(y);
    if (!line) break;
    for (let x = skip; x < line.length; x++) {
      const cell = line.getCell(x, scratch);
      if (!cell) continue;
      // Width 0 is the right-hand half of a double-width character: it holds no
      // string content of its own and must not advance the string index.
      if (cell.getWidth() === 0) continue;
      const content = cell.getChars();
      if (content === '') {
        // An untouched cell. It reads as a space, which is what makes it a
        // token boundary for the detector.
        chars.push(' ');
        cells.push({ x, y });
        continue;
      }
      // Pushed per UTF-16 code unit, not per code point, so that string offsets
      // from the detector index this array directly.
      for (let k = 0; k < content.length; k++) {
        chars.push(content.charAt(k));
        cells.push({ x, y });
      }
    }
    if (chars.length >= MAX_SCAN_CHARS) break;

    const next = buf.getLine(y + 1);
    if (next?.isWrapped) {
      skip = 0;
      y++;
      continue;
    }
    if (joined >= MAX_JOIN_ROWS) break;
    const here = readRow(buf, y, scratch);
    const below = readRow(buf, y + 1, scratch);
    if (here === null || below === null) break;
    const continues = joinedRowSkip(here, below);
    if (continues === null) break;
    // A row a TUI wrapped itself stops short of the margin, so the cells after
    // it read as spaces — and a run of spaces in the middle of the flattened
    // line would break the path back into the two tokens we just went to the
    // trouble of joining. They are dropped rather than emitted. Nothing is lost
    // with them: an `isWrapped` row is full by definition and never gets here,
    // rule 1 fires only on a row whose last column is occupied, and rule 1b
    // leaves behind nothing but the wrap's own blank columns.
    while (chars.length > 0 && chars[chars.length - 1] === ' ') {
      chars.pop();
      cells.pop();
    }
    skip = continues;
    joined++;
    y++;
  }

  return { text: chars.join(''), cells };
}

/** The links for one buffer line. Exported for testing without a live terminal. */
export function pathLinks(
  term: Terminal,
  bufferLineNumber: number,
  context: () => TerminalPathContext,
): ILink[] {
  const scanned = scanBufferLine(term, bufferLineNumber);
  const links: ILink[] = [];

  for (const match of findPaths(scanned.text)) {
    const from = scanned.cells[match.start];
    const to = scanned.cells[match.end - 1];
    if (from === undefined || to === undefined) continue;

    // xterm's range is 1-based and inclusive at both ends.
    links.push({
      range: {
        start: { x: from.x + 1, y: from.y + 1 },
        end: { x: to.x + 1, y: to.y + 1 },
      },
      text: scanned.text.slice(match.start, match.end),
      decorations: { pointerCursor: true, underline: true },
      // `match.path` deliberately, NOT the `text` xterm hands back: the text is
      // what is underlined, which still carries the `:12:5` suffix.
      activate: () => {
        revealInFiles(context(), match.path);
      },
    });
  }
  return links;
}

/**
 * A provider for TerminalView to register.
 *
 * It must be registered AFTER `WebLinksAddon` is loaded. xterm consults link
 * providers in registration order and drops a lower-priority link that
 * intersects a higher-priority one, so registering second is what guarantees a
 * URL stays a web link even if the path detector were ever to be fooled by one.
 * (It is not: terminalPaths.ts rejects any token containing `://` outright.
 * The ordering is the belt to that pair of braces.)
 */
export function createPathLinkProvider(
  term: Terminal,
  context: () => TerminalPathContext,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback): void {
      const links = pathLinks(term, bufferLineNumber, context);
      // `undefined`, not an empty array: xterm treats an array as "this
      // provider answered" when it decides which provider owns a cell.
      callback(links.length > 0 ? links : undefined);
    },
  };
}

/**
 * Hand the path to the files store.
 *
 * The session's working directory is looked up HERE, at click time, rather than
 * being captured when the provider was built: a workspace opened by deep link
 * renders before the sessions store has been refreshed, so a path captured at
 * mount would be resolved against a cwd of `undefined`.
 */
function revealInFiles(context: TerminalPathContext, path: string): void {
  const sessions = useSessionsStore();
  const cwd = context.sessionName
    ? (sessions.sessions.find((s) => s.name === context.sessionName)?.path ?? null)
    : null;
  useFilesStore().requestReveal(path, cwd);
}
