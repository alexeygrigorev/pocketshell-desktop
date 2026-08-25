import { describe, expect, it } from 'vitest';
import {
  COMPOSER_LAYOUT,
  clampGeometry,
  defaultGeometry,
  maxHeightIn,
  maximizedGeometry,
  moveGeometry,
  resizeGeometry,
  snapGeometry,
  type ComposerGeometry,
} from '../../src/shared/composerGeometry';

/**
 * The composer card's geometry rules (docs/COMPOSER.md §21.1). These are the
 * invariants a user can feel: the card never leaves the pane, never shrinks
 * below a usable size, and the edge you are NOT dragging does not move.
 */

/** A roomy pane, so nothing is clamped unless a test means it to be. */
const PANE = { width: 1200, height: 700 };

/** Every geometry the module produces must satisfy these, always. */
function expectLegal(g: ComposerGeometry, pane = PANE): void {
  expect(g.width).toBeGreaterThanOrEqual(Math.min(COMPOSER_LAYOUT.minWidth, pane.width));
  expect(g.height).toBeGreaterThanOrEqual(Math.min(COMPOSER_LAYOUT.minHeight, pane.height));
  expect(g.right).toBeGreaterThanOrEqual(0);
  expect(g.bottom).toBeGreaterThanOrEqual(0);
  expect(g.right + g.width).toBeLessThanOrEqual(pane.width);
  expect(g.bottom + g.height).toBeLessThanOrEqual(pane.height);
}

describe('defaults', () => {
  it('rests in the dock’s bottom-right corner at the default size', () => {
    expect(defaultGeometry()).toEqual({ right: 0, bottom: 0, width: 720, height: 240 });
  });

  it('caps height at 80% of the pane so the terminal is never fully covered', () => {
    expect(maxHeightIn({ width: 1000, height: 1000 })).toBe(800);
  });

  it('lets the floor win on a pane too short for the 80% cap', () => {
    // 80% of 200 is 160, below the 190 floor. A card shorter than its own
    // controls is useless, so the floor wins and the pane clips it.
    expect(maxHeightIn({ width: 800, height: 200 })).toBe(COMPOSER_LAYOUT.minHeight);
  });
});

describe('clampGeometry', () => {
  it('leaves a legal geometry alone', () => {
    const g = { right: 40, bottom: 60, width: 700, height: 300 };
    expect(clampGeometry(g, PANE)).toEqual(g);
  });

  it('pulls a card that hangs off the right edge back inside', () => {
    const g = clampGeometry({ right: -80, bottom: 0, width: 700, height: 300 }, PANE);
    expect(g.right).toBe(0);
    expectLegal(g);
  });

  it('pulls a card that has been pushed off the left edge back inside', () => {
    const g = clampGeometry({ right: 9999, bottom: 0, width: 700, height: 300 }, PANE);
    expect(g.right).toBe(PANE.width - 700);
    expectLegal(g);
  });

  it('shrinks a card wider than the pane rather than letting it overflow', () => {
    const g = clampGeometry({ right: 0, bottom: 0, width: 4000, height: 300 }, PANE);
    expect(g.width).toBe(PANE.width);
    expectLegal(g);
  });

  it('raises a card below the floor back up to it', () => {
    const g = clampGeometry({ right: 0, bottom: 0, width: 10, height: 10 }, PANE);
    expect(g.width).toBe(COMPOSER_LAYOUT.minWidth);
    expect(g.height).toBe(COMPOSER_LAYOUT.minHeight);
  });

  it('survives a pane smaller than the floor without producing nonsense', () => {
    const tiny = { width: 200, height: 120 };
    const g = clampGeometry(defaultGeometry(), tiny);
    expect(g.width).toBe(tiny.width);
    expect(g.height).toBe(tiny.height);
    expectLegal(g, tiny);
  });

  it('is idempotent', () => {
    const once = clampGeometry({ right: -50, bottom: 9999, width: 5000, height: 5 }, PANE);
    expect(clampGeometry(once, PANE)).toEqual(once);
  });
});

describe('moveGeometry', () => {
  const start = { right: 100, bottom: 100, width: 700, height: 300 };

  it('follows the pointer: dragging right and down reduces both offsets', () => {
    expect(moveGeometry(start, 30, 20, PANE)).toEqual({ ...start, right: 70, bottom: 80 });
  });

  it('dragging left and up increases both offsets', () => {
    expect(moveGeometry(start, -30, -20, PANE)).toEqual({ ...start, right: 130, bottom: 120 });
  });

  it('never lets the card leave the pane, however far the pointer goes', () => {
    const far = moveGeometry(start, 99999, 99999, PANE);
    expect(far.right).toBe(0);
    expect(far.bottom).toBe(0);
    expectLegal(far);

    const back = moveGeometry(start, -99999, -99999, PANE);
    expect(back.right).toBe(PANE.width - start.width);
    expect(back.bottom).toBe(PANE.height - start.height);
    expectLegal(back);
  });

  it('never resizes the card', () => {
    const moved = moveGeometry(start, 500, -400, PANE);
    expect(moved.width).toBe(start.width);
    expect(moved.height).toBe(start.height);
  });
});

describe('resizeGeometry', () => {
  const start = { right: 100, bottom: 100, width: 700, height: 300 };

  it('west: dragging the left edge left grows the card, right edge fixed', () => {
    const g = resizeGeometry(start, -50, 0, 'w', PANE);
    expect(g.width).toBe(750);
    expect(g.right).toBe(100);
  });

  it('east: dragging the right edge right grows the card, left edge fixed', () => {
    const g = resizeGeometry(start, 50, 0, 'e', PANE);
    expect(g.width).toBe(750);
    expect(g.right).toBe(50);
    // The left edge is where it was: pane - right - width.
    expect(PANE.width - g.right - g.width).toBe(PANE.width - start.right - start.width);
  });

  it('north: dragging the top edge up grows the card, bottom edge fixed', () => {
    const g = resizeGeometry(start, 0, -40, 'n', PANE);
    expect(g.height).toBe(340);
    expect(g.bottom).toBe(100);
  });

  it('south: dragging the bottom edge down grows the card, top edge fixed', () => {
    const g = resizeGeometry(start, 0, 40, 's', PANE);
    expect(g.height).toBe(340);
    expect(g.bottom).toBe(60);
    expect(PANE.height - g.bottom - g.height).toBe(PANE.height - start.bottom - start.height);
  });

  it('corners resize both axes at once', () => {
    const g = resizeGeometry(start, -50, -40, 'nw', PANE);
    expect(g.width).toBe(750);
    expect(g.height).toBe(340);
    expect(g.right).toBe(100);
    expect(g.bottom).toBe(100);
  });

  it('stops at the width floor instead of inverting the card', () => {
    const g = resizeGeometry(start, 99999, 0, 'w', PANE);
    expect(g.width).toBe(COMPOSER_LAYOUT.minWidth);
    expect(g.right).toBe(100);
    expectLegal(g);
  });

  it('stops at the height floor instead of inverting the card', () => {
    const g = resizeGeometry(start, 0, 99999, 'n', PANE);
    expect(g.height).toBe(COMPOSER_LAYOUT.minHeight);
    expect(g.bottom).toBe(100);
    expectLegal(g);
  });

  it('stops at the pane edge rather than growing past it', () => {
    const g = resizeGeometry(start, -99999, 0, 'w', PANE);
    expect(g.right).toBe(100);
    expect(g.width).toBe(PANE.width - 100);
    expectLegal(g);
  });

  it('honours the 80% height cap when dragging the top edge up', () => {
    const g = resizeGeometry(start, 0, -99999, 'n', PANE);
    expect(g.height).toBe(maxHeightIn(PANE));
    expect(g.bottom).toBe(100);
    expectLegal(g);
  });

  it('leaves the untouched axis alone', () => {
    const g = resizeGeometry(start, 60, 60, 'e', PANE);
    expect(g.height).toBe(start.height);
    expect(g.bottom).toBe(start.bottom);
  });
});

describe('snapGeometry', () => {
  it('pulls a nearly-flush card the rest of the way to its corner', () => {
    const g = snapGeometry({ right: 5, bottom: 7, width: 700, height: 300 }, PANE);
    expect(g.right).toBe(0);
    expect(g.bottom).toBe(0);
  });

  it('snaps to the far edges too, so both corners are reachable', () => {
    const g = snapGeometry(
      { right: PANE.width - 700 - 6, bottom: PANE.height - 300 - 4, width: 700, height: 300 },
      PANE,
    );
    expect(g.right).toBe(PANE.width - 700);
    expect(g.bottom).toBe(PANE.height - 300);
  });

  it('snaps each axis independently', () => {
    const g = snapGeometry({ right: 3, bottom: 260, width: 700, height: 300 }, PANE);
    expect(g.right).toBe(0);
    expect(g.bottom).toBe(260);
  });

  it('leaves a deliberately placed card alone', () => {
    const g = { right: 300, bottom: 200, width: 700, height: 300 };
    expect(snapGeometry(g, PANE)).toEqual(g);
  });

  it('never snaps further than the threshold', () => {
    const g = snapGeometry(
      { right: COMPOSER_LAYOUT.snapThreshold + 1, bottom: 0, width: 700, height: 300 },
      PANE,
    );
    expect(g.right).toBe(COMPOSER_LAYOUT.snapThreshold + 1);
  });
});

describe('maximizedGeometry', () => {
  it('fills the dock: full width, capped height, back in the corner', () => {
    const g = maximizedGeometry(PANE);
    expect(g).toEqual({ right: 0, bottom: 0, width: PANE.width, height: maxHeightIn(PANE) });
    expectLegal(g);
  });

  it('leaves the terminal a fifth of the pane to breathe in', () => {
    expect(maximizedGeometry(PANE).height).toBeLessThan(PANE.height);
  });
});
