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
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';
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

/** One flattened logical line, plus the cell each character came from. */
export interface ScannedLine {
  text: string;
  /** `cells[i]` is the 0-based buffer cell that produced `text[i]`. */
  cells: { x: number; y: number }[];
}

/**
 * Flatten the logical line that [bufferLineNumber] (1-based, as xterm passes
 * it to a link provider) belongs to.
 */
export function scanBufferLine(term: Terminal, bufferLineNumber: number): ScannedLine {
  const buf = term.buffer.active;
  const chars: string[] = [];
  const cells: { x: number; y: number }[] = [];

  // Walk up to the row the logical line STARTS on. A row is a continuation of
  // the one above it exactly when it is flagged wrapped, so the first row that
  // is not is where the line begins.
  let y = bufferLineNumber - 1;
  while (y > 0 && chars.length < MAX_SCAN_CHARS) {
    const line = buf.getLine(y);
    if (!line?.isWrapped) break;
    y--;
  }

  const scratch = buf.getNullCell();
  for (;;) {
    const line = buf.getLine(y);
    if (!line) break;
    for (let x = 0; x < line.length; x++) {
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
    if (!next?.isWrapped) break;
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
