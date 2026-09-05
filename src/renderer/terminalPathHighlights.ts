/**
 * At-rest highlighting for terminal path links — the half the hover link
 * provider cannot give.
 *
 * The user's acceptance test is the view at rest, and at rest the remote CLI
 * wins the styling: it colours its file references blue and underlines them,
 * but when ITS wrapper breaks a path across rows the underline attribute
 * covers only the first row's fragment, and the continuation sits plain. The
 * hover link (terminalLinks.ts) does reconstruct the whole path, but only
 * while the mouse is on it — so every at-rest screenshot kept reading as
 * "still not highlighting". This layer closes that gap: the full joined path
 * carries a block tint whenever it is on screen, mouse or no mouse.
 *
 * ## Why an onRender rescan, given the docs once said this was not viable
 *
 * `Terminal.registerDecoration` anchors to a buffer MARKER, and the old
 * objection was staleness: tmux repaints rows in place, so a cached
 * decoration comes to underline cells whose contents have moved on. The
 * escape is to never let a decoration outlive its render: `term.onRender`
 * reports exactly which viewport rows the renderer touched, and for each one
 * this layer DISPOSES the decorations it held for that row and re-derives
 * them from the buffer as it stands now, through the very same
 * {@link pathLinks} the hover provider uses — one detection pipeline, two
 * presentations. A decoration therefore never describes anything but the
 * frame it was scanned in; the per-frame cost is one rescan of the dirty
 * rows, which is the price the old note already anticipated.
 *
 * Two API facts shape the rest:
 *
 *   - decorations exist only on the NORMAL buffer (`registerDecoration`
 *     returns `undefined` when the alternate buffer is active). That is
 *     where scrolled CLI output lives anyway; an interactive TUI canvas is
 *     repainted constantly and gets no at-rest highlighting.
 *   - a marker is created as an offset from the cursor's absolute line
 *     (`viewportY + cursorY`), so the highlighter re-derives the offset for
 *     every row it refreshes rather than holding markers across scrolls.
 *
 * Decorations are keyed by viewport row and the whole viewport is revisited
 * on scroll (a scroll re-renders every row), so nothing survives long enough
 * to point at the wrong text; `onResize` clears outright and the next render
 * repopulates.
 */
import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { lastTextColumn, pathLinks, type TerminalPathContext } from './terminalLinks';

interface RowDecorations {
  marker: IMarker;
  decorations: IDecoration[];
}

export class PathHighlighter {
  private readonly rows = new Map<number, RowDecorations>();
  private readonly subscriptions: IDisposable[] = [];

  constructor(
    private readonly term: Terminal,
    private readonly context: () => TerminalPathContext,
    private readonly tint: () => string,
  ) {}

  /** Begin highlighting; one subscription to the render stream. */
  attach(): void {
    this.subscriptions.push(
      this.term.onRender(({ start, end }) => {
        const baseY = this.term.buffer.active.viewportY;
        for (let row = start; row <= end; row++) this.refreshRow(row, baseY);
      }),
      this.term.onResize(() => this.clear()),
    );
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    this.clear();
  }

  private refreshRow(row: number, baseY: number): void {
    const held = this.rows.get(row);
    if (held !== undefined) {
      for (const decoration of held.decorations) decoration.dispose();
      held.marker.dispose();
      this.rows.delete(row);
    }

    const buffer = this.term.buffer.active;
    if (buffer === this.term.buffer.alternate) return;
    // `pathLinks` speaks 1-based absolute buffer lines, as xterm's own link
    // provider contract does.
    const line = baseY + row + 1;
    const links = pathLinks(this.term, line, this.context);
    if (links.length === 0) return;

    // One marker per row; every link segment this row carries anchors to it.
    // The marker is the buffer line the decorations describe, so it is
    // created relative to the cursor's ABSOLUTE line (viewportY + cursorY).
    const cursorLine = baseY + buffer.cursorY;
    const marker = this.term.registerMarker(line - 1 - cursorLine);
    if (marker === undefined || marker.line < 0) {
      marker?.dispose();
      return;
    }

    const decorations: IDecoration[] = [];
    for (const link of links) {
      // The link spans one or more rows; this refresh concerns the segment on
      // THIS row only. A row that is neither the link's first nor its last
      // has no endpoint of its own in the range — the range records two cells
      // — so its segment is clamped to the row's own text: a reconstructed
      // row stops short of the pane and the padding after it is not path.
      if (line < link.range.start.y || line > link.range.end.y) continue;
      const rowEnd = lastTextColumn(this.term, line);
      const startX = line === link.range.start.y ? link.range.start.x : 1;
      const endX = line === link.range.end.y ? link.range.end.x : rowEnd;
      const width = endX - startX + 1;
      if (width <= 0) continue;
      const decoration = this.term.registerDecoration({
        marker,
        anchor: 'left',
        x: startX,
        width,
        backgroundColor: this.tint(),
        layer: 'bottom',
      });
      if (decoration !== undefined) decorations.push(decoration);
    }

    if (decorations.length === 0) {
      marker.dispose();
      return;
    }
    this.rows.set(row, { marker, decorations });
  }

  private clear(): void {
    for (const { marker, decorations } of this.rows.values()) {
      for (const decoration of decorations) decoration.dispose();
      marker.dispose();
    }
    this.rows.clear();
  }
}
