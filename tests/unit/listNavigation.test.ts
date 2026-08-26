import { describe, expect, it } from 'vitest';
import { adjacentIndex } from '../../src/shared/listNavigation';

/**
 * Where a directional key lands.
 *
 * One rule shared by the two lists an arrow chord walks — the workspace's tab
 * bar (`Ctrl+←`/`Ctrl+→`) and the session panel's folder rows (`Ctrl+↑`/`Ctrl+↓`)
 * — because "which index does this keypress land on" is one decision, and the
 * two ends of a single gesture must not drift apart.
 *
 * The property that earns the module is the CLAMP, and it is a deliberate
 * disagreement with `nextWorkspaceTabId` next door, which wraps for `Ctrl+Tab`.
 * Tab is a cycle; an arrow is a direction.
 */
describe('adjacentIndex', () => {
  it('steps one place in the direction asked for', () => {
    expect(adjacentIndex(4, 1, 1)).toBe(2);
    expect(adjacentIndex(4, 1, -1)).toBe(0);
  });

  it('STOPS at both walls rather than wrapping', () => {
    // The whole reason this is not `nextWorkspaceTabId`. A user pressing
    // `Ctrl+←` on the leftmost tab is asking to go further left; answering with
    // the far right end loses the position an arrow key exists to preserve.
    expect(adjacentIndex(4, 0, -1)).toBeNull();
    expect(adjacentIndex(4, 3, 1)).toBeNull();
  });

  it('lands on the first item when nothing is selected, whichever way it is going', () => {
    // -1 is not an error state: the panel has no active folder before the first
    // navigation. Both directions mean the same thing when there is no position
    // to move from, and doing nothing would make the chord look broken exactly
    // when the user is reaching for it to get started.
    expect(adjacentIndex(3, -1, 1)).toBe(0);
    expect(adjacentIndex(3, -1, -1)).toBe(0);
  });

  it('treats an index past the end as no position at all', () => {
    // A stale index — the row it named was closed between the keypress and the
    // lookup — must not step off into nothing.
    expect(adjacentIndex(3, 9, 1)).toBe(0);
  });

  it('has nowhere to go in an empty list', () => {
    expect(adjacentIndex(0, -1, 1)).toBeNull();
    expect(adjacentIndex(0, 0, -1)).toBeNull();
  });

  it('walks the whole list and stops, given repeated presses', () => {
    // The behaviour as a user experiences it: hold the key and you end up at
    // the end, not back where you started.
    const seen: number[] = [];
    let at = 0;
    for (let i = 0; i < 10; i++) {
      const next = adjacentIndex(4, at, 1);
      if (next === null) break;
      at = next;
      seen.push(next);
    }
    expect(seen).toEqual([1, 2, 3]);
  });
});
