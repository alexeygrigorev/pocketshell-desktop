import { describe, expect, it } from 'vitest';
import { adjacentIndex, listStep } from '../../src/shared/listNavigation';

/**
 * Where a directional key lands.
 *
 * One rule shared by the two lists a directional chord walks — the workspace's
 * tab bar (`Ctrl+[`/`Ctrl+]`) and the session panel's folder rows
 * (`Ctrl+↑`/`Ctrl+↓`)
 * — because "which index does this keypress land on" is one decision, and the
 * two ends of a single gesture must not drift apart.
 *
 * The property that earns the module is the CLAMP. A directional step is not a
 * cycle: landing on the opposite end of a list is not what "further left"
 * asked for, and the position lost is the one thing that key preserves.
 * (The `Ctrl+Tab` cycle this once disagreed with is gone; see the tombstone
 * in shared/shortcuts.ts.)
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

describe('listStep — the directional keys of the Files tree', () => {
  it('steps arrows through adjacentIndex and clamps at both ends', () => {
    expect(listStep(3, 0, 'down')).toBe(1);
    expect(listStep(3, 2, 'down')).toBeNull();
    expect(listStep(3, 2, 'up')).toBe(1);
    expect(listStep(3, 0, 'up')).toBeNull();
  });

  it('arrows from "nothing focused" land on the first row', () => {
    expect(listStep(3, -1, 'down')).toBe(0);
    expect(listStep(3, -1, 'up')).toBe(0);
  });

  it('Home and End are destinations from anywhere', () => {
    expect(listStep(5, 3, 'home')).toBe(0);
    expect(listStep(5, 0, 'end')).toBe(4);
    expect(listStep(5, -1, 'end')).toBe(4);
  });

  it('an empty list has nowhere to land', () => {
    expect(listStep(0, 0, 'down')).toBeNull();
    expect(listStep(0, -1, 'home')).toBeNull();
  });
});
