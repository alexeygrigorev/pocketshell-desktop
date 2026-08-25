import { describe, expect, it } from 'vitest';
import { pointAnchor, popupPlacement, type Box } from '../../src/shared/popupPlacement';

/**
 * The arithmetic behind PopupMenu.vue.
 *
 * The bug this whole module exists for was a menu that rendered at exactly its
 * clipping ancestor's bottom edge and was therefore invisible — so the cases
 * worth pinning are the ones where a naive "just put it below" would put the
 * menu somewhere the user cannot reach it.
 */

const VIEWPORT: Box = { left: 0, top: 0, width: 1280, height: 800 };
/** A `+` button at the top of the tab strip, where the real one sits. */
const PLUS: Box = { left: 300, top: 0, width: 32, height: 39 };
const MENU: Box = { left: 0, top: 0, width: 180, height: 120 };

describe('popupPlacement', () => {
  it('hangs below the anchor with the left edges aligned', () => {
    const p = popupPlacement(PLUS, MENU, VIEWPORT);
    expect(p).toMatchObject({ left: 300, flipped: false });
    // 39 (anchor bottom) + 4 (gap).
    expect(p.top).toBe(43);
  });

  it('flips above when there is no room below and more room above', () => {
    const anchor: Box = { left: 300, top: 740, width: 32, height: 24 };
    const p = popupPlacement(anchor, MENU, VIEWPORT);
    expect(p.flipped).toBe(true);
    // 740 (anchor top) - 4 (gap) - 120 (menu).
    expect(p.top).toBe(616);
  });

  it('stays below and scrolls when NEITHER side fits but below is roomier', () => {
    // A short window: 200px tall, anchor above the middle. Flipping would move
    // the menu into the smaller gap, which is strictly worse than staying put
    // and letting the list scroll.
    const shortViewport: Box = { left: 0, top: 0, width: 1280, height: 200 };
    const anchor: Box = { left: 10, top: 60, width: 32, height: 24 };
    const p = popupPlacement(anchor, MENU, shortViewport);
    expect(p.flipped).toBe(false);
    // below: 200 - 84 - 4 - 8 = 104. above: 60 - 4 - 8 = 48.
    expect(p.maxHeight).toBe(104);
  });

  it('flips when above is genuinely roomier, even though neither side fits', () => {
    const shortViewport: Box = { left: 0, top: 0, width: 1280, height: 200 };
    const anchor: Box = { left: 10, top: 150, width: 32, height: 24 };
    const p = popupPlacement(anchor, MENU, shortViewport);
    // below: 200 - 174 - 12 = 14. above: 150 - 12 = 138.
    expect(p.flipped).toBe(true);
    expect(p.maxHeight).toBe(138);
  });

  it('shifts left rather than flipping when it would overflow the right edge', () => {
    const anchor: Box = { left: 1200, top: 100, width: 32, height: 24 };
    const p = popupPlacement(anchor, MENU, VIEWPORT);
    // 1200 + 180 + 8 - 1280 = 108 over, so it slides 108px left.
    expect(p.left).toBe(1092);
    expect(p.flipped).toBe(false);
  });

  it('keeps the LEFT edge on screen when the viewport is narrower than the menu', () => {
    // The labels are on the left; losing them would make the menu unreadable
    // in exactly the case where it is already cramped.
    const narrow: Box = { left: 0, top: 0, width: 120, height: 800 };
    const p = popupPlacement({ left: 100, top: 10, width: 20, height: 20 }, MENU, narrow);
    expect(p.left).toBe(8);
  });

  it('never reports a negative height budget', () => {
    // An anchor taller than the window (a pathological measurement, or a menu
    // opened mid-layout) must not produce a negative `max-height`, which CSS
    // would reject and which would silently un-cap the menu.
    const p = popupPlacement({ left: 0, top: 0, width: 10, height: 5000 }, MENU, VIEWPORT);
    expect(p.maxHeight).toBe(0);
  });
});

describe('pointAnchor', () => {
  it('makes a context menu open at the cursor with no second code path', () => {
    const p = popupPlacement(pointAnchor(400, 300), MENU, VIEWPORT);
    expect(p).toMatchObject({ left: 400, top: 304, flipped: false });
  });

  it('flips a context menu opened near the bottom of the window', () => {
    const p = popupPlacement(pointAnchor(400, 780), MENU, VIEWPORT);
    expect(p.flipped).toBe(true);
    expect(p.top).toBe(656);
  });
});
