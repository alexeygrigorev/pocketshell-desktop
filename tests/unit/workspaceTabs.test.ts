import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceTabs,
  labelForRemainder,
  nextWorkspaceTabId,
  numberCollisions,
  renamedSessionName,
  stripSessionPrefix,
  tabIdAtIndex,
  TERMINAL_LABEL,
} from '../../src/shared/workspaceTabs';
import { sanitisePart, sessionBaseName } from '../../src/shared/sessionNameParts';

/**
 * The pure half of docs/WORKSPACE.md §3. These are the rules the user
 * described in the most detail, so they are the ones worth pinning.
 */

describe('stripSessionPrefix', () => {
  it('returns an empty remainder for an exact match', () => {
    expect(stripSessionPrefix('git-dtc-website', 'git-dtc-website')).toBe('');
  });

  it('strips the prefix and its separator', () => {
    expect(stripSessionPrefix('git-dtc-website-import', 'git-dtc-website')).toBe('import');
  });

  it('requires the `-` boundary, so a longer folder name is not claimed', () => {
    // `~/git/red-stamp` must not adopt `~/git/red-stampede`'s session just
    // because one name is a character-prefix of the other.
    expect(stripSessionPrefix('git-red-stampede', 'git-red-stamp')).toBeNull();
  });

  it('returns null for a name that is not derived from the folder', () => {
    expect(stripSessionPrefix('nightly-build', 'git-dtc-website')).toBeNull();
  });

  it('never strips against an empty prefix', () => {
    expect(stripSessionPrefix('anything', '')).toBeNull();
  });
});

describe('labelForRemainder', () => {
  it('labels the empty remainder `Terminal`', () => {
    // The folder's default session. It used to read `main`, which shared no
    // word with the `Terminal 2` sitting next to it.
    expect(labelForRemainder('')).toBe('Terminal');
    expect(TERMINAL_LABEL).toBe('Terminal');
  });

  it('labels a purely numeric remainder `Terminal <n>`', () => {
    // This is what `freeSessionNameCommand`'s `-2`/`-3` walk produces.
    expect(labelForRemainder('2')).toBe('Terminal 2');
    expect(labelForRemainder('17')).toBe('Terminal 17');
  });

  it('numbers the family with a SPACE, not the name\'s hyphen', () => {
    // The tmux names really are `git-dtc-website-2`, but this is a display
    // label and every other numbered label on the bar is spaced (`Files 2`).
    expect(labelForRemainder('2')).not.toBe('Terminal-2');
    expect(labelForRemainder('')).toBe(TERMINAL_LABEL);
    expect(labelForRemainder('2')).toBe(`${TERMINAL_LABEL} 2`);
  });

  it('keeps a clear name clear', () => {
    expect(labelForRemainder('import')).toBe('import');
    // Not "just a number": a name that merely contains digits is a name.
    expect(labelForRemainder('v2')).toBe('v2');
    expect(labelForRemainder('2fa')).toBe('2fa');
    // A remainder that IS the word keeps it verbatim too — no rewrite fires,
    // and the collision counter (not this function) deals with the repeat.
    expect(labelForRemainder('Terminal')).toBe('Terminal');
  });
});

describe('numberCollisions', () => {
  it('leaves the first occurrence plain and numbers the rest', () => {
    const out = numberCollisions([{ label: 'a' }, { label: 'b' }, { label: 'a' }, { label: 'a' }]);
    expect(out.map((t) => t.label)).toEqual(['a', 'b', 'a 2', 'a 3']);
  });

  it('numbers by position, so an appended tab cannot renumber the bar', () => {
    const before = numberCollisions([{ label: 'Files' }, { label: 'Files' }]);
    expect(before.map((t) => t.label)).toEqual(['Files', 'Files 2']);
    const after = numberCollisions([{ label: 'Files' }, { label: 'Files' }, { label: 'Files' }]);
    expect(after.slice(0, 2).map((t) => t.label)).toEqual(['Files', 'Files 2']);
  });
});

describe('buildWorkspaceTabs', () => {
  const prefix = sessionBaseName('~/git/dtc-website', '/home/alexey');

  it('derives the prefix the same way the host names the folder', () => {
    expect(prefix).toBe('git-dtc-website');
  });

  it('labels the brief\'s worked example', () => {
    const tabs = buildWorkspaceTabs(
      [
        { name: 'git-dtc-website-import', created: 200 },
        { name: 'git-dtc-website', created: 100 },
      ],
      prefix,
    );
    expect(tabs.map((t) => t.label)).toEqual(['Terminal', 'import']);
  });

  it('renames the LABEL only — the id, the session and the remainder stand', () => {
    // `Terminal` is what the tab reads. What it joins, what the route keys off
    // and what a rename edits are all still the tmux name and the stripped
    // remainder, so nothing downstream can be keyed off the display word.
    const tabs = buildWorkspaceTabs([{ name: 'git-dtc-website', created: 100 }], prefix);
    expect(tabs[0]).toEqual({
      kind: 'session',
      id: 'git-dtc-website',
      session: 'git-dtc-website',
      label: 'Terminal',
      remainder: '',
      created: 100,
    });
  });

  it('orders session tabs oldest first, then Files tabs', () => {
    const tabs = buildWorkspaceTabs(
      [
        { name: 'git-dtc-website-3', created: 300 },
        { name: 'git-dtc-website', created: 100 },
        { name: 'git-dtc-website-2', created: 200 },
      ],
      prefix,
      [{ id: 'f1' }, { id: 'f2' }],
    );
    expect(tabs.map((t) => t.kind)).toEqual([
      'session',
      'session',
      'session',
      'files',
      'files',
    ]);
    // One family, in creation order: the folder's default, then its `-2` and
    // `-3`, and the numbering reads as a list rather than as an exception.
    expect(tabs.map((t) => t.label)).toEqual([
      'Terminal',
      'Terminal 2',
      'Terminal 3',
      'Files',
      'Files 2',
    ]);
  });

  it('breaks a creation-time tie on the name, so the order is total', () => {
    // Every row has the same timestamp on a host with no enrichment, because
    // `parseSessionsList` sets activity === created.
    const tabs = buildWorkspaceTabs(
      [
        { name: 'git-dtc-website-zeta', created: 100 },
        { name: 'git-dtc-website-alpha', created: 100 },
      ],
      prefix,
    );
    expect(tabs.map((t) => t.label)).toEqual(['alpha', 'zeta']);
  });

  it('keeps a non-derived session name in full', () => {
    const tabs = buildWorkspaceTabs(
      [
        { name: 'git-dtc-website', created: 100 },
        { name: 'nightly-build', created: 200 },
      ],
      prefix,
    );
    expect(tabs.map((t) => t.label)).toEqual(['Terminal', 'nightly-build']);
    expect(tabs[1]).toMatchObject({ remainder: null });
  });

  it('numbers a stripped remainder that collides with a foreign session name', () => {
    const tabs = buildWorkspaceTabs(
      [
        { name: 'git-dtc-website-import', created: 100 },
        { name: 'import', created: 200 },
      ],
      prefix,
    );
    expect(tabs.map((t) => t.label)).toEqual(['import', 'import 2']);
  });

  it('numbers across kinds — a session called Files does not get a free pass', () => {
    const tabs = buildWorkspaceTabs([{ name: 'Files', created: 100 }], prefix, [{ id: 'f1' }]);
    expect(tabs.map((t) => t.label)).toEqual(['Files', 'Files 2']);
  });

  it('is a bar of Files tabs alone when the folder has no sessions', () => {
    const tabs = buildWorkspaceTabs([], prefix, [{ id: 'f1', path: '~/git/dtc-website' }]);
    expect(tabs).toEqual([
      { kind: 'files', id: 'f1', label: 'Files', path: '~/git/dtc-website' },
    ]);
  });
});

describe('renamedSessionName', () => {
  const prefix = 'git-dtc-website';

  it('re-applies the prefix, so a rename cannot detach a session from its folder', () => {
    expect(renamedSessionName('staging', prefix, 'import', sanitisePart)).toBe(
      'git-dtc-website-staging',
    );
  });

  it('promotes a session to the folder default when the field is cleared', () => {
    expect(renamedSessionName('   ', prefix, 'import', sanitisePart)).toBe('git-dtc-website');
  });

  it('commits the raw name for a tab whose label IS the session name', () => {
    expect(renamedSessionName('release', prefix, null, sanitisePart)).toBe('release');
  });

  it('sanitises to the alphabet `tmuxctl <name>` can still join', () => {
    // `.` and `:` collapse to `_`, everything else illegal collapses to `-`.
    expect(renamedSessionName('my.branch', prefix, 'import', sanitisePart)).toBe(
      'git-dtc-website-my_branch',
    );
    expect(renamedSessionName('feat/x', prefix, 'import', sanitisePart)).toBe(
      'git-dtc-website-feat-x',
    );
  });

  it('refuses a name with nothing alphanumeric left, rather than inventing one', () => {
    expect(renamedSessionName(':::', '', null, sanitisePart)).toBeNull();
    expect(renamedSessionName('', '---', 'import', sanitisePart)).toBeNull();
  });
});

describe('nextWorkspaceTabId', () => {
  const prefix = 'git-dtc-website';

  /**
   * A real bar, built the way the view builds it, so the traversal is pinned
   * against the DISPLAY order rather than against a hand-written array that
   * could drift from it: two session tabs, then two Files tabs.
   */
  const bar = buildWorkspaceTabs(
    [
      { name: 'git-dtc-website', created: 100 },
      { name: 'git-dtc-website-2', created: 200 },
    ],
    prefix,
    [{ id: 'f1' }, { id: 'f2' }],
  );

  it('is built in the order it will be traversed', () => {
    expect(bar.map((t) => t.id)).toEqual(['git-dtc-website', 'git-dtc-website-2', 'f1', 'f2']);
    expect(bar.map((t) => t.label)).toEqual(['Terminal', 'Terminal 2', 'Files', 'Files 2']);
  });

  it('steps forward one tab', () => {
    expect(nextWorkspaceTabId(bar, 'git-dtc-website', 1)).toBe('git-dtc-website-2');
  });

  it('steps backward one tab', () => {
    expect(nextWorkspaceTabId(bar, 'f2', -1)).toBe('f1');
  });

  it('crosses from the session tabs into the Files tabs, in display order', () => {
    // Files tabs are tabs. A chord that stopped at the last session would
    // strand the user one press short of something they can see.
    expect(nextWorkspaceTabId(bar, 'git-dtc-website-2', 1)).toBe('f1');
    expect(nextWorkspaceTabId(bar, 'f1', -1)).toBe('git-dtc-website-2');
  });

  it('walks the whole bar and returns to where it started', () => {
    const walked: string[] = [];
    let at: string | null = bar[0]?.id ?? null;
    for (let i = 0; i < bar.length; i += 1) {
      at = nextWorkspaceTabId(bar, at, 1);
      walked.push(at as string);
    }
    expect(walked).toEqual(['git-dtc-website-2', 'f1', 'f2', 'git-dtc-website']);
  });

  it('wraps off the end forward', () => {
    expect(nextWorkspaceTabId(bar, 'f2', 1)).toBe('git-dtc-website');
  });

  it('wraps off the start backward', () => {
    // `%` keeps the sign of its left operand in JS, so index 0 stepping back is
    // the one place this arithmetic can quietly produce -1.
    expect(nextWorkspaceTabId(bar, 'git-dtc-website', -1)).toBe('f2');
  });

  it('starts from outside the bar when the active id names no tab', () => {
    // A stale selection — a session that vanished under the bar — is exactly
    // the state a user reaches for this chord to escape, so it must move.
    expect(nextWorkspaceTabId(bar, 'git-dtc-website-gone', 1)).toBe('git-dtc-website');
    expect(nextWorkspaceTabId(bar, 'git-dtc-website-gone', -1)).toBe('f2');
  });

  it('treats a null active id the same way', () => {
    expect(nextWorkspaceTabId(bar, null, 1)).toBe('git-dtc-website');
    expect(nextWorkspaceTabId(bar, null, -1)).toBe('f2');
  });

  it('cycles a single tab to itself rather than to null', () => {
    const one = buildWorkspaceTabs([{ name: 'git-dtc-website', created: 100 }], prefix);
    expect(nextWorkspaceTabId(one, 'git-dtc-website', 1)).toBe('git-dtc-website');
    expect(nextWorkspaceTabId(one, 'git-dtc-website', -1)).toBe('git-dtc-website');
  });

  it('has nothing to name on an empty bar', () => {
    expect(nextWorkspaceTabId([], null, 1)).toBeNull();
    expect(nextWorkspaceTabId([], 'anything', -1)).toBeNull();
  });
});

describe('tabIdAtIndex', () => {
  const bar = buildWorkspaceTabs(
    [
      { name: 'git-dtc-website', created: 100 },
      { name: 'git-dtc-website-2', created: 200 },
    ],
    'git-dtc-website',
    [{ id: 'f1' }],
  );

  it('is 0-based, in display order', () => {
    expect(tabIdAtIndex(bar, 0)).toBe('git-dtc-website');
    expect(tabIdAtIndex(bar, 2)).toBe('f1');
  });

  it('does nothing rather than clamping when the bar is not that long', () => {
    // `Ctrl+7` on a bar of three means "the seventh tab", and there isn't one.
    expect(tabIdAtIndex(bar, 3)).toBeNull();
    expect(tabIdAtIndex(bar, -1)).toBeNull();
    expect(tabIdAtIndex([], 0)).toBeNull();
  });
});
