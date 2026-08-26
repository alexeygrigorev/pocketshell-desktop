/**
 * Stepping through a visible list with a directional key.
 *
 * Pure, and shared by the two lists an arrow chord walks: the workspace's tab
 * bar (`Ctrl+←` / `Ctrl+→`) and the session panel's folder rows (`Ctrl+↑` /
 * `Ctrl+↓`). They hold different things and neither knows about the other, but
 * "which index does this keypress land on" is one decision, and writing it
 * twice is how the two ends of one gesture drift apart.
 *
 * ## Why this CLAMPS where the tab cycle wraps
 *
 * `nextWorkspaceTabId` — `Ctrl+Tab` — wraps, and that is right for it: Tab is a
 * CYCLE, the gesture every app uses to visit each tab in turn and come back
 * round. An arrow is not a cycle, it is a direction. A user pressing `Ctrl+←`
 * on the leftmost tab is asking to go further left; teleporting them to the
 * far right end answers a question they did not ask, and the position they lose
 * is the one thing an arrow key is supposed to preserve.
 *
 * So the two chords deliberately differ, and the difference is legible from the
 * keys themselves rather than something to memorise: Tab cycles, arrows travel
 * and stop at the wall.
 */

/**
 * The index a step lands on, or null when the step cannot be taken.
 *
 * Null means "nothing to do" and is returned for all three of the ways that
 * happens — an empty list, a step off either end — because every caller treats
 * them identically: no navigation, and no cancelled keystroke to explain.
 *
 * `from` may be -1 for "nothing is selected", which is not an error state: the
 * panel has no active folder before the first navigation. A step from there
 * lands on the FIRST item whichever direction it is going, because both
 * directions mean the same thing when there is no position to move from.
 */
export function adjacentIndex(count: number, from: number, direction: 1 | -1): number | null {
  if (count <= 0) return null;
  if (from < 0 || from >= count) return 0;
  const next = from + direction;
  if (next < 0 || next >= count) return null;
  return next;
}
