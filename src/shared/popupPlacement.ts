/**
 * Where a popup menu goes, as pure arithmetic.
 *
 * ## Why this exists at all, and why it is not `position: absolute`
 *
 * The `+` menu in the folder workspace was written as `position: absolute;
 * top: 100%` inside the tab strip, and it did not work — the user clicked `+`
 * and nothing happened. The cause is one line of CSS two elements away:
 *
 *     .tabs { overflow-x: auto; }
 *
 * The tab strip has to scroll horizontally, because a folder with many
 * sessions must not wrap its tabs onto a second row (that would change the
 * terminal's height, which is a remote tmux reflow — see `.tab-body`). But CSS
 * does not let you scroll one axis and overflow the other: when either
 * `overflow-x` or `overflow-y` is not `visible`, a computed value of `visible`
 * on the other becomes `auto`. So the strip clips VERTICALLY too, and a menu
 * hanging below it is scrolled out of a 39px-tall box rather than drawn over
 * the pane.
 *
 * Measured in Electron's own Chromium against a reproduction of the real
 * nesting: `overflow-y` computed `auto`, the strip's box was `top: 0,
 * bottom: 39`, and the menu was laid out at `top: 39` — exactly the clip edge,
 * zero pixels visible. `z-index` cannot help, because clipping happens before
 * stacking.
 *
 * Three fixes were available: stop the strip scrolling (no — the scroll is
 * load-bearing), move the anchor out of the clipping ancestor (works for the
 * `+`, but not for a file-tree context menu, whose anchor is a row INSIDE a
 * scrolling list), or take the menu out of the flow entirely. The third is the
 * only one that answers both call sites, so the menu is teleported to `<body>`
 * and positioned `fixed` from its anchor's measured rect — which is also the
 * only approach that is correct when the anchor's container is mid-scroll.
 *
 * The arithmetic lives here, away from the DOM, because it is the part with
 * edge cases: a menu near the bottom of the window has to flip, a menu near
 * the right edge has to shift, and a menu taller than the viewport has to do
 * something defensible rather than hang off both ends.
 */

/** A measured box, in viewport coordinates. `DOMRect` is assignable to this. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PopupPlacement {
  left: number;
  top: number;
  /** True when the menu was flipped above its anchor. Callers use it for the
   *  transform-origin, so the open animation grows from the right edge. */
  flipped: boolean;
  /** Set when the menu had to be shortened to fit; the caller caps its height
   *  and lets the list scroll internally. */
  maxHeight: number;
}

/** Gap between the anchor and the menu, in px. */
const GAP = 4;
/** Keep this much clear of every viewport edge, so a menu never bleeds off. */
const MARGIN = 8;

/**
 * Place a [menu] of the given size against [anchor], inside [viewport].
 *
 * The rules, in the order they are applied:
 *
 *  1. **Below by default**, left edges aligned. That is where a dropdown
 *     belongs and it is what the anchor's own affordance implies.
 *  2. **Flip above** when it does not fit below AND there is more room above.
 *     Not "when it does not fit below" alone: near the vertical middle of a
 *     short window neither side fits, and flipping into the smaller gap would
 *     be strictly worse than staying put and scrolling.
 *  3. **Shift, never flip, horizontally.** A menu that jumps to the other side
 *     of the cursor reads as a different menu; sliding it left until it fits
 *     keeps it under the pointer. Clamped at the left margin, so a viewport
 *     narrower than the menu still shows its left edge (where the labels are)
 *     rather than its right.
 *  4. **Cap the height** to whatever the chosen side actually has. The caller
 *     scrolls the list inside that cap, so a long menu is reachable instead of
 *     being drawn off the bottom of the window.
 */
export function popupPlacement(anchor: Box, menu: Box, viewport: Box): PopupPlacement {
  const spaceBelow = viewport.height - (anchor.top + anchor.height) - GAP - MARGIN;
  const spaceAbove = anchor.top - GAP - MARGIN;

  const fitsBelow = menu.height <= spaceBelow;
  // Rule 2: only prefer above when it is genuinely roomier.
  const flipped = !fitsBelow && spaceAbove > spaceBelow;

  const maxHeight = Math.max(0, flipped ? spaceAbove : spaceBelow);
  const height = Math.min(menu.height, maxHeight);
  const top = flipped ? anchor.top - GAP - height : anchor.top + anchor.height + GAP;

  // Rule 3: shift left to fit, then clamp so the left edge is always on screen.
  const overflowRight = anchor.left + menu.width + MARGIN - (viewport.left + viewport.width);
  const shifted = overflowRight > 0 ? anchor.left - overflowRight : anchor.left;
  const left = Math.max(viewport.left + MARGIN, shifted);

  return { left, top, flipped, maxHeight };
}

/**
 * The anchor box for a CONTEXT menu, which has a point rather than a control.
 *
 * A zero-size box at the pointer makes {@link popupPlacement} do exactly the
 * right thing with no second code path: "below the anchor" becomes "below the
 * cursor", and the flip and shift rules apply unchanged.
 */
export function pointAnchor(x: number, y: number): Box {
  return { left: x, top: y, width: 0, height: 0 };
}
