import { describe, it, expect } from 'vitest';
import {
  buildCrumbs,
  CRUMB_TAIL_SEGMENTS,
  FILE_ROW_CAP,
  matchesQuery,
  viewFileRows,
} from '../../src/renderer/fileListView';

/** A listing in the order the store leaves it: dirs first, then files, A-Z. */
function listing(count: number, prefix = 'file'): { name: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${String(i).padStart(4, '0')}.yaml`,
  }));
}

describe('matchesQuery', () => {
  it('is a case-insensitive substring', () => {
    expect(matchesQuery('Report-2026.CSV', 'report')).toBe(true);
    expect(matchesQuery('Report-2026.CSV', '2026')).toBe(true);
    expect(matchesQuery('Report-2026.CSV', 'xlsx')).toBe(false);
  });

  it('treats a blank query as "everything", not "nothing"', () => {
    expect(matchesQuery('anything', '')).toBe(true);
    expect(matchesQuery('anything', '   ')).toBe(true);
  });
});

describe('viewFileRows', () => {
  it('caps the rendered rows and reports the true total', () => {
    const view = viewFileRows(listing(3946));
    expect(view.rows).toHaveLength(FILE_ROW_CAP);
    expect(view.total).toBe(3946);
    expect(view.hidden).toBe(3946 - FILE_ROW_CAP);
    expect(view.filtered).toBe(false);
  });

  it('shows everything when the folder fits under the cap', () => {
    const view = viewFileRows(listing(8));
    expect(view.rows).toHaveLength(8);
    expect(view.hidden).toBe(0);
  });

  it('grows with the cap, which is what "Load more" does', () => {
    const entries = listing(250);
    expect(viewFileRows(entries, { cap: 100 }).rows).toHaveLength(100);
    expect(viewFileRows(entries, { cap: 200 }).rows).toHaveLength(200);
    expect(viewFileRows(entries, { cap: 300 }).hidden).toBe(0);
  });

  it('FILTERS THE WHOLE LISTING, not the capped slice', () => {
    // The match sits at index 3000 — far past any cap. Filtering the slice
    // first would make it unreachable, which is the bug this asserts against.
    const entries = listing(4000);
    entries[3000] = { name: 'needle.txt' };
    const view = viewFileRows(entries, { query: 'needle' });
    expect(view.rows.map((r) => r.name)).toEqual(['needle.txt']);
    expect(view.total).toBe(1);
    expect(view.hidden).toBe(0);
    expect(view.filtered).toBe(true);
  });

  it('caps the filtered result too, and counts the matches not the folder', () => {
    const entries = [...listing(500, 'alpha'), ...listing(500, 'beta')];
    const view = viewFileRows(entries, { query: 'beta', cap: 100 });
    expect(view.rows).toHaveLength(100);
    expect(view.total).toBe(500);
    expect(view.hidden).toBe(400);
    expect(view.rows.every((r) => r.name.startsWith('beta'))).toBe(true);
  });

  it('preserves the listing order inside both the filter and the cap', () => {
    const entries = [
      { name: 'src' },
      { name: 'tests' },
      { name: 'a.ts' },
      { name: 'b.ts' },
      { name: 'c.ts' },
    ];
    expect(viewFileRows(entries, { cap: 3 }).rows.map((r) => r.name)).toEqual([
      'src',
      'tests',
      'a.ts',
    ]);
    expect(viewFileRows(entries, { query: 't' }).rows.map((r) => r.name)).toEqual([
      'tests',
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
  });

  it('reports an empty filter result honestly rather than falling back', () => {
    const view = viewFileRows(listing(50), { query: 'zzz' });
    expect(view.rows).toEqual([]);
    expect(view.total).toBe(0);
    expect(view.filtered).toBe(true);
  });

  it('does not mutate the listing it was given', () => {
    const entries = listing(5);
    const before = entries.map((e) => e.name);
    viewFileRows(entries, { query: 'file-0001' });
    expect(entries.map((e) => e.name)).toEqual(before);
  });
});

describe('buildCrumbs', () => {
  it('collapses the home prefix into a single ~ rather than repeating it', () => {
    const crumbs = buildCrumbs('/home/alexey', '/home/alexey');
    expect(crumbs).toEqual([{ kind: 'segment', name: '~', path: '/home/alexey' }]);
  });

  it('roots at / outside the home', () => {
    const crumbs = buildCrumbs('/srv/www', '/home/alexey');
    expect(crumbs.map((c) => (c.kind === 'segment' ? c.name : '…'))).toEqual(['/', 'srv', 'www']);
  });

  it('falls back to the absolute form when the home is not resolved yet', () => {
    const crumbs = buildCrumbs('/home/alexey/git', '');
    expect(crumbs.map((c) => (c.kind === 'segment' ? c.name : '…'))).toEqual([
      '/',
      'home',
      'alexey',
      'git',
    ]);
  });

  it('leaves a short path alone', () => {
    const crumbs = buildCrumbs('/home/alexey/git/site', '/home/alexey');
    expect(crumbs.map((c) => (c.kind === 'segment' ? c.name : '…'))).toEqual(['~', 'git', 'site']);
  });

  it('never collapses when collapsing would not save a cell', () => {
    // Three segments: root + three cells is the same four cells a collapse
    // would produce, so hollowing it out would lose information for nothing.
    const crumbs = buildCrumbs('/a/b/c', '');
    expect(crumbs.map((c) => (c.kind === 'segment' ? c.name : '…'))).toEqual(['/', 'a', 'b', 'c']);
  });

  it('is never more than four cells, at any depth', () => {
    for (const depth of [1, 2, 3, 4, 8, 20]) {
      const cwd = '/' + Array.from({ length: depth }, (_, i) => `seg${i}`).join('/');
      expect(buildCrumbs(cwd, '').length).toBeLessThanOrEqual(4);
    }
  });

  it('collapses the middle of a deep path, keeping root and the tail', () => {
    // The user's reported case: three wrapped lines of breadcrumb.
    const cwd = '/home/alexey/git/ai-engineering-field-guide/job-market/data_structured/2026-02-27';
    const crumbs = buildCrumbs(cwd, '/home/alexey');
    expect(crumbs.map((c) => (c.kind === 'segment' ? c.name : '…'))).toEqual([
      '~',
      '…',
      'data_structured',
      '2026-02-27',
    ]);
    // Four cells, whatever the depth — that is what makes one line a promise
    // rather than a hope.
    expect(crumbs).toHaveLength(2 + CRUMB_TAIL_SEGMENTS);
  });

  it('keeps the hidden segments navigable rather than discarding them', () => {
    const cwd = '/home/alexey/git/ai-engineering-field-guide/job-market/data_structured/2026-02-27';
    const gap = buildCrumbs(cwd, '/home/alexey').find((c) => c.kind === 'gap');
    expect(gap).toBeDefined();
    expect(gap!.kind === 'gap' && gap!.hidden.map((h) => h.name)).toEqual([
      'git',
      'ai-engineering-field-guide',
      'job-market',
    ]);
    // Each one is a real destination, not a label.
    expect(gap!.kind === 'gap' && gap!.hidden[1]!.path).toBe(
      '/home/alexey/git/ai-engineering-field-guide',
    );
  });

  it('builds cumulative paths for the kept tail segments', () => {
    const cwd = '/a/b/c/d/e';
    const crumbs = buildCrumbs(cwd, '');
    const last = crumbs[crumbs.length - 1]!;
    expect(last.kind === 'segment' && last.path).toBe('/a/b/c/d/e');
  });

  it('tolerates a trailing slash and repeated separators', () => {
    expect(buildCrumbs('/a//b/', '').map((c) => (c.kind === 'segment' ? c.name : '…'))).toEqual([
      '/',
      'a',
      'b',
    ]);
  });
});
