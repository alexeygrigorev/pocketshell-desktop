/**
 * Window bounds as persisted across launches, and the validation that makes a
 * stored record safe to restore.
 *
 * The record is user-state on disk (electron-store under `userData`), so it is
 * VALIDATED rather than trusted — the same rule the workspace memory
 * (renderer/workspaceState.ts) and the settings store already follow. It is
 * also state written about a MACHINE it may not run on again: a restore onto a
 * laptop that no longer has the external display, or into a docked profile
 * whose work areas moved, must degrade to "open centered at the default size",
 * not to a window stranded where no pointer can reach it.
 *
 * Kept free of Electron imports so the sanitizer is unit-testable from the
 * plain-node suite — callers hand in the work areas they read from
 * `screen.getAllDisplays()`.
 */

/** The persisted shape. `x`/`y` are the RESTORED rect; null means "let the OS center it". */
export interface PersistedWindowBounds {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  maximized: boolean;
}

/** The `workArea` half of Electron's `Display`, spelled out for tests. */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Floor matches BrowserWindow's own `minWidth`/`minHeight` in main/index.ts. */
export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;
/** Generous ceiling; a bounds file claiming 50000px wide is corrupt, not enthusiastic. */
export const MAX_WINDOW_EDGE = 20_000;

/**
 * How much of a restored window must land on a real display for its position
 * to be kept. A few pixels of overlap is not usable — the title bar has to be
 * grabbable and a meaningful slab of the window visible — so a restored rect
 * must overlap a work area by at least this much on BOTH axes, or the position
 * is dropped and the window opens centered.
 */
const MIN_VISIBLE_EDGE = 80;

/**
 * Turn an untrusted stored value into bounds safe to hand to BrowserWindow.
 *
 * Returns null when nothing usable survives: the caller then opens at the
 * default size and lets the OS place the window. Every field is rescued
 * individually, so a record with a good size but a stale position still
 * restores the size.
 *
 * A maximized window's stored rect is the PRE-maximize geometry (main captures
 * `getNormalBounds()`), so `maximized` never changes the size validation — it
 * only tells main to re-maximize after the window is created with the normal
 * rect, which is what keeps the un-maximize target where the user left it.
 */
export function sanitizeWindowBounds(
  raw: unknown,
  workAreas: readonly WorkArea[],
): PersistedWindowBounds | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;

  const width = clampEdge(doc['width'], MIN_WINDOW_WIDTH);
  const height = clampEdge(doc['height'], MIN_WINDOW_HEIGHT);
  if (width === null || height === null) return null;

  const position = readPosition(doc, width, height, workAreas);

  return {
    width,
    height,
    x: position?.x ?? null,
    y: position?.y ?? null,
    maximized: doc['maximized'] === true,
  };
}

/** Clamp one stored edge, or null when it is not a finite positive number. */
function clampEdge(value: unknown, min: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > MAX_WINDOW_EDGE) return MAX_WINDOW_EDGE;
  return rounded;
}

/**
 * The stored position, when it survives.
 *
 * Secondary displays legitimately produce negative coordinates (a monitor left
 * of the primary starts at x = -1920), so the sign is not the test — overlap
 * with a REAL work area is. Requiring MIN_VISIBLE_EDGE on both axes is what
 * rejects the two ways a position goes stale: the display it named is gone
 * (no overlap with anything), and the display moved (the overlap, if any, is a
 * sliver).
 */
function readPosition(
  doc: Record<string, unknown>,
  width: number,
  height: number,
  workAreas: readonly WorkArea[],
): { x: number; y: number } | null {
  const x = doc['x'];
  const y = doc['y'];
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (typeof y !== 'number' || !Number.isFinite(y)) return null;
  for (const area of workAreas) {
    const overlapW = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
    const overlapH = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
    if (overlapW >= MIN_VISIBLE_EDGE && overlapH >= MIN_VISIBLE_EDGE) {
      return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return null;
}
