import { describe, expect, it } from 'vitest';
import {
  sanitizeWindowBounds,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
} from '../../src/shared/windowBounds';

/**
 * The restore-side validator for the window geometry persisted across
 * launches (main/windowState.ts). The failure being prevented: a bounds file
 * written on a docked machine restored onto the bare laptop must open
 * centered, not stranded where no display is.
 */

/** One 1920×1080 primary at the origin, the single-display baseline. */
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };

/** A secondary to the LEFT, so legitimate stored coordinates go negative. */
const LEFT = { x: -1920, y: 0, width: 1920, height: 1040 };

function bounds(over: Record<string, unknown>): Record<string, unknown> {
  return { width: 1280, height: 800, x: 100, y: 100, maximized: false, ...over };
}

describe('sanitizeWindowBounds', () => {
  it('rejects everything that is not a usable record', () => {
    for (const raw of [null, undefined, '1280x800', 42, [], { width: 'big', height: 800 }]) {
      expect(sanitizeWindowBounds(raw, [PRIMARY])).toBeNull();
    }
  });

  it('restores a valid on-screen record verbatim', () => {
    expect(sanitizeWindowBounds(bounds({}), [PRIMARY])).toEqual({
      width: 1280,
      height: 800,
      x: 100,
      y: 100,
      maximized: false,
    });
  });

  it('keeps NEGATIVE coordinates that name a real left-hand display', () => {
    const rec = bounds({ x: -1800, y: 50 });
    expect(sanitizeWindowBounds(rec, [LEFT, PRIMARY])?.x).toBe(-1800);
  });

  it('drops a position stranded off-screen but keeps the size', () => {
    const restored = sanitizeWindowBounds(bounds({ x: -6000, y: 100 }), [PRIMARY]);
    expect(restored).toEqual({
      width: 1280,
      height: 800,
      x: null,
      y: null,
      maximized: false,
    });
  });

  it('drops a sliver of overlap — the title bar must stay grabbable', () => {
    // 8px hanging over the primary's right edge: technically visible, practically not.
    const restored = sanitizeWindowBounds(bounds({ x: 1920 - 8, y: 100 }), [PRIMARY]);
    expect(restored?.x).toBeNull();
    // Just over the threshold survives.
    const kept = sanitizeWindowBounds(bounds({ x: 1920 - 1280 + 100 }), [PRIMARY]);
    expect(kept?.x).not.toBeNull();
  });

  it('clamps a corrupt size instead of trusting it', () => {
    const shrunk = sanitizeWindowBounds(bounds({ width: 200, height: -50 }), [PRIMARY]);
    expect(shrunk?.width).toBe(MIN_WINDOW_WIDTH);
    expect(shrunk?.height).toBe(MIN_WINDOW_HEIGHT);
    const huge = sanitizeWindowBounds(bounds({ width: 99_999 }), [PRIMARY]);
    expect(huge?.width).toBeLessThanOrEqual(20_000);
  });

  it('carries the maximized flag through untouched', () => {
    expect(sanitizeWindowBounds(bounds({ maximized: true }), [PRIMARY])?.maximized).toBe(true);
    // A truthy non-true is not `true`: the flag is boolean, not loose.
    expect(sanitizeWindowBounds(bounds({ maximized: 'yes' }), [PRIMARY])?.maximized).toBe(false);
  });

  it('rescues the size from a record whose position is garbage', () => {
    const restored = sanitizeWindowBounds(
      bounds({ x: Number.NaN, y: undefined }),
      [PRIMARY],
    );
    expect(restored).toEqual({
      width: 1280,
      height: 800,
      x: null,
      y: null,
      maximized: false,
    });
  });
});
