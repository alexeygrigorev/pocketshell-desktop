import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceTabs,
  labelForRemainder,
  numberCollisions,
  renamedSessionName,
  stripSessionPrefix,
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
  it('labels the empty remainder `main`', () => {
    expect(labelForRemainder('')).toBe('main');
  });

  it('labels a purely numeric remainder `Terminal <n>`', () => {
    // This is what `freeSessionNameCommand`'s `-2`/`-3` walk produces.
    expect(labelForRemainder('2')).toBe('Terminal 2');
    expect(labelForRemainder('17')).toBe('Terminal 17');
  });

  it('keeps a clear name clear', () => {
    expect(labelForRemainder('import')).toBe('import');
    // Not "just a number": a name that merely contains digits is a name.
    expect(labelForRemainder('v2')).toBe('v2');
    expect(labelForRemainder('2fa')).toBe('2fa');
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
    expect(tabs.map((t) => t.label)).toEqual(['main', 'import']);
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
    expect(tabs.map((t) => t.label)).toEqual([
      'main',
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
    expect(tabs.map((t) => t.label)).toEqual(['main', 'nightly-build']);
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
