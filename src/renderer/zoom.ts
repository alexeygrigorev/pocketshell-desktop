/**
 * App zoom as a setting: one whole percentage, and the ladder it steps along.
 *
 * ---------------------------------------------------------------------------
 * ZOOM IS NOT FONT SIZE, AND THE TWO ARE DELIBERATELY INDEPENDENT
 * ---------------------------------------------------------------------------
 * `terminalFontSize` sets the terminal's cell in CSS pixels. Zoom changes what
 * a CSS pixel IS, for the whole window at once — panels, tabs, the composer
 * and the terminal together — which is what a browser's Ctrl+= does and what
 * the user is asking for when they press it.
 *
 * They compose multiplicatively and neither should try to be the other:
 *
 *   - Coupling them (zoom scaling `terminalFontSize`) would make the terminal
 *     the only surface zoom moved, which is not what zoom means, and would
 *     write a value into a preference the user set by hand — a control that
 *     silently rewrites its own number is worse than no control.
 *   - Making zoom adjust font size instead would leave the app chrome at 100%,
 *     so the one user with a 4K laptop panel who wants everything bigger would
 *     have to raise two settings and still not get the panel text.
 *
 * The one place the independence is felt is arithmetic: at 80% zoom, a 16px
 * terminal font paints at about 12.8 device-independent px. That is why the
 * settings screen shows zoom as a PERCENTAGE and the sizes in PIXELS, with a
 * live sample under each — two different units and two different previews, so
 * nothing about them reads as the same knob twice.
 *
 * Everything here is pure so the ladder, the clamp and the formatting can be
 * tested without a window, exactly as `fonts.ts` does for size.
 */

/**
 * The zoom bounds.
 *
 * Chromium itself allows 25%–500%, and that range is precisely the failure the
 * brief names: a terminal at 25% has cells barely over 4 device px, where
 * tmux's status line — the line the user reads to know which session they are
 * in — stops resolving at all, and at 500% a 1280px window holds about a dozen
 * columns, so the Settings screen the user would need in order to undo it no
 * longer fits on screen. A preference must not be able to make its own escape
 * hatch unreachable.
 *
 * 50 at the bottom: a 16px cell still lands on 8 device px, which is the same
 * floor `FONT_SIZE_MIN` picks for the same reason.
 * 200 at the top: everything in the app is still readable and the settings
 * panel still fits a 800x600 minimum window, which is what `minWidth`/
 * `minHeight` in the main process guarantee is the smallest it can get.
 *
 * Ctrl+0 is exempt from nothing — it sets 100, which is inside the range —
 * but it is the guaranteed way back regardless of where the user has got to.
 */
export const ZOOM_PERCENT_MIN = 50;
export const ZOOM_PERCENT_MAX = 200;
/** Unzoomed. Exactly what shipped before this setting existed. */
export const ZOOM_PERCENT_DEFAULT = 100;

/**
 * The steps Ctrl+= / Ctrl+- walk, and what the +/- buttons in Settings use.
 *
 * Chromium's own ladder, cropped to the bounds above. A fixed ladder rather
 * than a multiplier because the steps have to be REVERSIBLE: with `x * 1.1`
 * and `/ 1.1` a user who zooms in three times and out three times lands on
 * 99.9%, and the percentage they are shown never returns to a round number.
 * Every entry here is its own inverse's neighbour, so in-then-out is exactly
 * where you started.
 *
 * Electron's default menu stepped `zoomLevel` by 0.5, i.e. ~9.5% per press
 * compounding — that is where the reversibility problem came from, and it is
 * not carried over.
 */
export const ZOOM_STEPS: readonly number[] = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];

/** Pull `n` into [ZOOM_PERCENT_MIN, ZOOM_PERCENT_MAX] and onto a whole percent. */
export function clampZoomPercent(n: number): number {
  return Math.min(ZOOM_PERCENT_MAX, Math.max(ZOOM_PERCENT_MIN, Math.round(n)));
}

/**
 * Parse a stored zoom. Same contract as `parseFontSize`: an out-of-range
 * number is clamped because it carries an intent worth honouring at the legal
 * limit, and anything that is not a finite number is rejected, which sends the
 * settings store to the default.
 */
export function parseZoomPercent(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return clampZoomPercent(n);
}

/**
 * The next rung up (`direction` 1) or down (-1) from `current`.
 *
 * `current` is not required to BE on the ladder — a hand-edited settings blob
 * or a future step change can leave it between rungs — so the search is for
 * the nearest step strictly past it in that direction. That both steps and
 * re-aligns in one press, rather than needing two.
 *
 * At either end the value is pinned rather than wrapped: a shortcut that
 * jumped from 200% back to 50% because the user held the key one press too
 * long would be indistinguishable from a bug.
 */
export function stepZoomPercent(current: number, direction: 1 | -1): number {
  const from = clampZoomPercent(current);
  if (direction === 1) {
    return ZOOM_STEPS.find((step) => step > from) ?? ZOOM_PERCENT_MAX;
  }
  const below = ZOOM_STEPS.filter((step) => step < from);
  return below.length > 0 ? below[below.length - 1]! : ZOOM_PERCENT_MIN;
}

/** How the percentage is written wherever it is shown to a person. */
export function formatZoomPercent(percent: number): string {
  return `${clampZoomPercent(percent)}%`;
}

/**
 * The factor Chromium wants, from the percentage a person reads.
 *
 * Clamped on the way out as well as on the way in, so the ONE call that
 * actually moves the window cannot be handed a value the store somehow let
 * through. `webFrame.setZoomFactor` takes a multiplier where 1 is unzoomed.
 */
export function zoomFactor(percent: number): number {
  return clampZoomPercent(percent) / 100;
}
