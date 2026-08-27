import { describe, expect, it } from 'vitest';
import {
  ARROW,
  arrowHead,
  constrainToAngle,
  distance,
  hitTestText,
  isBlankText,
  isDegenerateDrag,
  layoutText,
  SNAP_RADIANS,
  TEXT,
  textFontSize,
  textHalfLeading,
  wrapLines,
  type Point,
} from '../../src/shared/doodleGeometry';

/**
 * The arithmetic behind the doodle surface's arrow and text tools.
 *
 * Everything here is a property a user can see go wrong: a head that outgrows
 * its own shaft, a "horizontal" arrow that is out by a degree, a pasted URL
 * that runs off the edge of the exported PNG. None of it needs a canvas, which
 * is exactly why it lives in a module that does not have one.
 */

const ORIGIN: Point = { x: 100, y: 100 };

/** A fake proportional font: every character is 10 wide. */
const measure10 = (s: string): number => s.length * 10;

/** Angle of the vector from `a` to `b`, in radians. */
function angleOf(a: Point, b: Point): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

describe('arrowHead', () => {
  it('points along the drag, with the tip at the head end', () => {
    const head = arrowHead(ORIGIN, { x: 200, y: 100 }, 6);
    expect(head).not.toBeNull();
    expect(head?.tip).toEqual({ x: 200, y: 100 });
    // Both barbs sit behind the tip, mirrored about the shaft.
    expect(head!.barbA.x).toBeLessThan(200);
    expect(head!.barbB.x).toBeLessThan(200);
    expect(head!.barbA.y + head!.barbB.y).toBeCloseTo(200, 6);
  });

  it('scales the head with the stroke width', () => {
    const thin = arrowHead(ORIGIN, { x: 600, y: 100 }, 3)!;
    const thick = arrowHead(ORIGIN, { x: 600, y: 100 }, 12)!;
    expect(distance(thin.tip, thin.barbA)).toBeCloseTo(3 * ARROW.headRatio, 6);
    expect(distance(thick.tip, thick.barbA)).toBeCloseTo(12 * ARROW.headRatio, 6);
  });

  /**
   * The reason `maxHeadFraction` exists. A 20px drag at width 12 wants a 48px
   * head, which would be a triangle longer than the arrow it belongs to.
   */
  it('never lets the head eat the whole arrow', () => {
    const length = 20;
    const head = arrowHead(ORIGIN, { x: 100 + length, y: 100 }, 12)!;
    expect(distance(head.tip, head.barbA)).toBeCloseTo(length * ARROW.maxHeadFraction, 6);
    // A visible shaft survives: the baseline is strictly ahead of the tail.
    expect(head.shaftEnd.x).toBeGreaterThan(ORIGIN.x);
  });

  /**
   * The shaft stops at the barb baseline so a fat round line cap cannot poke
   * out of the point of the arrow.
   */
  it('ends the shaft short of the tip, behind the barbs', () => {
    const to = { x: 400, y: 100 };
    const head = arrowHead(ORIGIN, to, 12)!;
    expect(head.shaftEnd.x).toBeLessThan(to.x);
    // The stop is on the shaft, not off to one side.
    expect(head.shaftEnd.y).toBeCloseTo(100, 6);
    // …and level with the barbs, so the triangle covers the joint.
    expect(head.shaftEnd.x).toBeCloseTo(head.barbA.x, 6);
    expect(head.shaftEnd.x).toBeCloseTo(head.barbB.x, 6);
  });

  it('works at any angle, not just the axes', () => {
    const to = { x: 300, y: 400 };
    const head = arrowHead(ORIGIN, to, 6)!;
    // The shaft end lies on the segment from tail to tip.
    expect(angleOf(ORIGIN, head.shaftEnd)).toBeCloseTo(angleOf(ORIGIN, to), 6);
    expect(distance(ORIGIN, head.shaftEnd)).toBeLessThan(distance(ORIGIN, to));
  });

  /**
   * A click is not an arrow. Returning null rather than a head is what keeps
   * `atan2(0, 0) === 0` from inventing an east-pointing arrow out of a tap.
   */
  it('returns null for a drag too short to have a direction', () => {
    expect(arrowHead(ORIGIN, ORIGIN, 6)).toBeNull();
    expect(arrowHead(ORIGIN, { x: 101, y: 100 }, 6)).toBeNull();
    expect(arrowHead(ORIGIN, { x: 100 + ARROW.minLength, y: 100 }, 6)).not.toBeNull();
  });
});

describe('isDegenerateDrag', () => {
  it('treats a click, and a hand that wobbled, as no drag at all', () => {
    expect(isDegenerateDrag(ORIGIN, ORIGIN)).toBe(true);
    expect(isDegenerateDrag(ORIGIN, { x: 101, y: 101 })).toBe(true);
  });

  it('accepts a real drag', () => {
    expect(isDegenerateDrag(ORIGIN, { x: 140, y: 100 })).toBe(false);
  });
});

describe('constrainToAngle', () => {
  it('snaps a near-horizontal drag flat', () => {
    const snapped = constrainToAngle(ORIGIN, { x: 300, y: 108 });
    expect(snapped.y).toBeCloseTo(100, 6);
    expect(snapped.x).toBeCloseTo(300, 6);
  });

  it('snaps a near-vertical drag upright', () => {
    const snapped = constrainToAngle(ORIGIN, { x: 106, y: 400 });
    expect(snapped.x).toBeCloseTo(100, 6);
    expect(snapped.y).toBeCloseTo(400, 6);
  });

  it('lands on a multiple of 45 degrees from anywhere', () => {
    for (const to of [
      { x: 220, y: 190 },
      { x: 10, y: 260 },
      { x: -40, y: -33 },
      { x: 100, y: 3 },
    ]) {
      const snapped = constrainToAngle(ORIGIN, to);
      const angle = angleOf(ORIGIN, snapped);
      const steps = angle / SNAP_RADIANS;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    }
  });

  /**
   * Projection, not length preservation. The head has to stay under the
   * pointer when Shift goes down mid-drag, or the arrow appears to lunge
   * sideways at the moment of snapping.
   */
  it('projects onto the ray rather than keeping the drag length', () => {
    // 45 degrees away from the snapped horizontal: cos(45) of the length.
    const raw = { x: 100 + 100, y: 100 + 100 };
    const snapped = constrainToAngle(ORIGIN, raw, Math.PI / 2);
    // Nearest half-pi ray is either east or south; both are 45 degrees off, so
    // whichever wins is at length * cos(45).
    expect(distance(ORIGIN, snapped)).toBeCloseTo(Math.hypot(100, 100) * Math.SQRT1_2, 6);
    expect(distance(ORIGIN, snapped)).toBeLessThan(distance(ORIGIN, raw));
  });

  it('never pushes the head behind the tail', () => {
    const snapped = constrainToAngle(ORIGIN, ORIGIN, Math.PI);
    expect(snapped.x).toBeGreaterThanOrEqual(ORIGIN.x - 1e-9);
  });
});

/** The three mark weights the toolbar offers — `WIDTHS` in DoodleCanvas.vue. */
const MARK_WEIGHTS = [6, 12, 24];

describe('textFontSize', () => {
  it('follows the stroke width, so text and strokes are one hand', () => {
    expect(textFontSize(12)).toBe(12 * TEXT.sizeRatio);
    expect(textFontSize(24)).toBe(24 * TEXT.sizeRatio);
    // Strictly increasing, which is the whole promise the weight control makes.
    expect(textFontSize(6)).toBeLessThan(textFontSize(12));
    expect(textFontSize(12)).toBeLessThan(textFontSize(24));
  });

  it('floors widths below the toolbar rather than taking the ratio literally', () => {
    // 3 * 8 = 24, the size that was reported as unreadable. The lightest weight
    // the toolbar now offers is 6, so the floor never binds for a toolbar
    // selection — it is a guard for any caller that passes a smaller width,
    // and the test pins it where the complaint actually came from.
    expect(3 * TEXT.sizeRatio).toBeLessThan(TEXT.minSize);
    expect(textFontSize(3)).toBe(TEXT.minSize);
    // And no offered weight needs it: the ratio alone stays above the floor.
    for (const weight of MARK_WEIGHTS) {
      expect(weight * TEXT.sizeRatio).toBeGreaterThan(TEXT.minSize);
    }
  });

  /**
   * The regression this whole change exists to prevent: "for annotations font
   * size is too small".
   *
   * Written against what reaches the EYE, not against the constants, so it
   * cannot be satisfied by editing the number it checks. Logical canvas pixels
   * are not CSS pixels — the sheet is a bitmap of up to 2048px shown inside the
   * `md` overlay's ~700px frame, a scale of about 0.34 — and the old ladder of
   * 12 / 24 / 48 arrived as 4 / 8 / 16 CSS px, two of the three settings below
   * `--fs-100`, the smallest type the app sets anywhere.
   *
   * So: at every selectable mark weight, on the smallest realistic sheet, the
   * annotation must be at least as big as the app's own smallest type. The old
   * numbers fail this at two weights out of three.
   */
  it('stays legible on the shrunken sheet at every mark weight', () => {
    const SHEET_SHRINK = 700 / 2048; // ~0.34: the `md` panel against a capped backdrop
    const SMALLEST_UI_TYPE = 11; // --fs-100, in CSS pixels
    for (const weight of MARK_WEIGHTS) {
      expect(textFontSize(weight) * SHEET_SHRINK).toBeGreaterThanOrEqual(SMALLEST_UI_TYPE);
    }
  });
});

describe('textHalfLeading', () => {
  /**
   * The number that decides whether a caption lands where it was typed. The
   * canvas anchors the glyph top at the origin; CSS centres the glyph box in a
   * line box of `line-height`, so the editing overlay has to be lifted by this
   * much or the caption hops upwards the moment it is committed.
   */
  it('is half the gap between the line box and the glyph box', () => {
    // 100px type, 1.5 leading, glyphs 120 tall: 150 - 120 = 30, halved.
    expect(textHalfLeading(100, 1.5, 120)).toBeCloseTo(15, 6);
  });

  it('scales with the font, so one correction serves every mark weight', () => {
    const ratio = 1.3846;
    for (const size of [48, 96, 192]) {
      expect(textHalfLeading(size, ratio, size * 1.21)).toBeCloseTo(
        textHalfLeading(1, ratio, 1.21) * size,
        6,
      );
    }
    // …and it is not zero at any of them, which is why it cannot be skipped.
    expect(textHalfLeading(36, ratio, 36 * 1.21)).toBeGreaterThan(0);
  });

  /**
   * jsdom's `measureText` reports a width and nothing else, and so would any
   * canvas whose font failed to resolve. A missing metric must not become a
   * NaN offset that puts the caret nowhere at all.
   */
  it('falls back to a font-shaped ratio when the canvas has no metrics', () => {
    const fallback = textHalfLeading(48, 1.5, null);
    expect(fallback).toBeCloseTo((48 * 1.5 - 48 * TEXT.contentBoxRatio) / 2, 6);
    expect(textHalfLeading(48, 1.5, 0)).toBeCloseTo(fallback, 6);
    expect(Number.isFinite(fallback)).toBe(true);
  });

  /**
   * A theme could set `--lh-300` tighter than the glyph box. That means the
   * lines overlap symmetrically, not that the caption should be pushed up out
   * of the picture.
   */
  it('never lifts the text above the origin', () => {
    expect(textHalfLeading(48, 0.8, 48 * 1.21)).toBe(0);
  });
});

describe('wrapLines', () => {
  it('greedily fills each line', () => {
    // 10px per character, so a 100px line holds ten characters, spaces
    // included. Greedy: take the next word whenever it still fits.
    expect(wrapLines('aaa bbb ccc', 100, measure10)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapLines('aaaa bbbb cccc', 100, measure10)).toEqual(['aaaa bbbb', 'cccc']);
    expect(wrapLines('aaaaa bbbbb', 100, measure10)).toEqual(['aaaaa', 'bbbbb']);
  });

  it('keeps a line that fits exactly', () => {
    expect(wrapLines('aaaaaaaaaa', 100, measure10)).toEqual(['aaaaaaaaaa']);
  });

  /**
   * Rule 1. Greedy wrapping over the whole string would pull "b" up onto the
   * first line, silently flattening a list the user laid out on purpose.
   */
  it('never merges across a newline the user typed', () => {
    expect(wrapLines('a\nb', 1000, measure10)).toEqual(['a', 'b']);
  });

  it('keeps a blank line the user asked for', () => {
    expect(wrapLines('a\n\nb', 1000, measure10)).toEqual(['a', '', 'b']);
  });

  /**
   * Rule 3, and the reason it matters: a path or a URL typed onto a screenshot
   * has no spaces, so without character breaking it would run past the right
   * edge of the bitmap and be cropped by the PNG — invisible while editing and
   * permanent in the export.
   */
  it('breaks a word that cannot fit on a line of its own', () => {
    expect(wrapLines('aaaaaaa', 30, measure10)).toEqual(['aaa', 'aaa', 'a']);
    expect(wrapLines('/very/long/path/name', 50, measure10)).toEqual([
      '/very',
      '/long',
      '/path',
      '/name',
    ]);
  });

  it('lets a short word continue the tail of a broken one', () => {
    // 'aaaaaaa' is 70 wide and breaks into 'aaaaa' + 'aa'; 'aa b' is 40, so the
    // next word joins the tail instead of starting a third line.
    expect(wrapLines('aaaaaaa b', 50, measure10)).toEqual(['aaaaa', 'aa b']);
  });

  it('gives an unbreakably wide character its own line rather than looping', () => {
    const wide = (s: string): number => s.length * 500;
    expect(wrapLines('abc', 100, wide)).toEqual(['a', 'b', 'c']);
  });

  it('disables wrapping rather than hanging when there is no room at all', () => {
    expect(wrapLines('a b c', 0, measure10)).toEqual(['a b c']);
    expect(wrapLines('a\nb', -10, measure10)).toEqual(['a', 'b']);
  });

  it('leaves an empty string as one empty line', () => {
    expect(wrapLines('', 100, measure10)).toEqual(['']);
  });
});

describe('layoutText', () => {
  const base = {
    origin: ORIGIN,
    fontSize: 24,
    lineHeightRatio: 1.5,
    sheetWidth: 1000,
    measure: measure10,
  };

  it('boxes the block from its top-left, in the space a textarea would occupy', () => {
    const layout = layoutText({ ...base, text: 'ab\ncdef' });
    expect(layout.lines).toEqual(['ab', 'cdef']);
    expect(layout.x).toBe(100);
    expect(layout.y).toBe(100);
    expect(layout.width).toBe(40); // the longest line
    expect(layout.lineHeight).toBe(36);
    // Two lines, each carrying its full leading — the same height a two-row
    // textarea has, which is what keeps the editor and the paint aligned.
    expect(layout.height).toBe(72);
  });

  /**
   * The wrap width is measured from the ORIGIN to the right edge of the sheet,
   * so text placed near the edge wraps instead of running off the bitmap.
   */
  it('wraps against the remaining width of the sheet, not the whole sheet', () => {
    const nearEdge = layoutText({
      ...base,
      text: 'aaa bbb',
      origin: { x: 940, y: 10 },
      sheetWidth: 1000,
    });
    expect(nearEdge.lines).toEqual(['aaa', 'bbb']);

    const roomy = layoutText({ ...base, text: 'aaa bbb', origin: { x: 0, y: 10 } });
    expect(roomy.lines).toEqual(['aaa bbb']);
  });

  it('keeps a margin between the text and the edge', () => {
    // 1000 - 900 = 100px to the edge, minus 24 * 0.5 of padding = 88, so a
    // 90px word must break even though it would "fit" flush to the edge.
    const layout = layoutText({ ...base, text: 'aaaaaaaaa', origin: { x: 900, y: 0 } });
    expect(TEXT.edgePadding).toBeGreaterThan(0);
    expect(layout.lines.length).toBeGreaterThan(1);
  });

  /**
   * A caret placed hard against the right edge leaves a negative width once the
   * edge padding is taken off, and a non-positive width switches wrapping off
   * entirely — text that runs past the bitmap and is cropped by the PNG, which
   * is invisible while editing and permanent in the export. That sliver is
   * `edgePadding * fontSize` wide, so it grew with the font: unreachable at
   * 24px, 48px of the sheet at the heaviest weight now.
   */
  it('still wraps for a caret placed hard against the right edge', () => {
    const layout = layoutText({
      ...base,
      text: 'aaaaaaaaaaaa',
      origin: { x: 1000, y: 0 },
      sheetWidth: 1000,
    });
    // One character per line is ugly. Losing the caption off the edge is worse.
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines.join('')).toBe('aaaaaaaaaaaa');
  });
});

describe('hitTestText', () => {
  const layout = layoutText({
    text: 'ab\ncdef',
    origin: ORIGIN,
    fontSize: 24,
    lineHeightRatio: 1.5,
    sheetWidth: 1000,
    measure: measure10,
  });

  it('hits inside the block', () => {
    expect(hitTestText(layout, { x: 110, y: 110 })).toBe(true);
    expect(hitTestText(layout, { x: 139, y: 170 })).toBe(true);
  });

  /**
   * The slop is what makes "click the words to fix the typo" work: the box is
   * only as wide as the LONGEST line, so clicking just past the end of a short
   * line — visually inside the annotation — would otherwise miss.
   */
  it('forgives a click just outside the ragged edge', () => {
    const pad = layout.fontSize * TEXT.hitPadding;
    expect(hitTestText(layout, { x: layout.x + layout.width + pad / 2, y: 110 })).toBe(true);
  });

  it('misses a click that is properly elsewhere', () => {
    expect(hitTestText(layout, { x: 400, y: 110 })).toBe(false);
    expect(hitTestText(layout, { x: 110, y: 400 })).toBe(false);
    expect(hitTestText(layout, { x: 110, y: 10 })).toBe(false);
  });
});

describe('isBlankText', () => {
  it('treats whitespace as nothing, the way the composer treats a blank draft', () => {
    expect(isBlankText('')).toBe(true);
    expect(isBlankText('   \n\t ')).toBe(true);
    expect(isBlankText(' a ')).toBe(false);
  });
});
