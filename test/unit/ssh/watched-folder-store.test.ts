import { beforeEach, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import { WatchedFolderStore } from '../../../src/ssh/data/watched-folder-store';

async function createTestDb(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();
  return new SQL.Database();
}

describe('WatchedFolderStore', () => {
  let store: WatchedFolderStore;

  beforeEach(async () => {
    store = new WatchedFolderStore(await createTestDb(), ':memory:');
  });

  it('persists watched folders per host in order', () => {
    const first = store.add({ hostId: 1, label: 'api', path: '~/git/api' });
    const second = store.add({ hostId: 1, label: 'web', path: '~/git/web' });
    store.add({ hostId: 2, label: 'other', path: '~/git/other' });

    expect(store.list(1).map((folder) => [folder.id, folder.label, folder.orderIndex])).toEqual([
      [first, 'api', 0],
      [second, 'web', 1],
    ]);
  });

  it('updates, deletes, and compacts order', () => {
    const first = store.add({ hostId: 1, label: 'api', path: '~/git/api' });
    const second = store.add({ hostId: 1, label: 'web', path: '~/git/web' });

    expect(store.update(second, { label: 'frontend', enabled: false })).toBe(true);
    expect(store.get(second)).toMatchObject({ label: 'frontend', enabled: false });
    expect(store.delete(first)).toBe(true);

    expect(store.list(1).map((folder) => [folder.id, folder.orderIndex])).toEqual([[second, 0]]);
  });

  it('moves and reorders folders', () => {
    const first = store.add({ hostId: 1, label: 'one', path: '~/code/one' });
    const second = store.add({ hostId: 1, label: 'two', path: '~/code/two' });
    const third = store.add({ hostId: 1, label: 'three', path: '~/code/three' });

    expect(store.move(third, 'up')).toBe(true);
    expect(store.list(1).map((folder) => folder.id)).toEqual([first, third, second]);

    expect(store.reorder(1, [second, third, first])).toBe(true);
    expect(store.list(1).map((folder) => folder.id)).toEqual([second, third, first]);
  });

  it('deduplicates per-host paths', () => {
    const first = store.add({ hostId: 1, label: 'api', path: '~/git/api' });
    const duplicate = store.add({
      hostId: 1,
      label: 'API copy',
      path: '~/git/api',
      source: 'discovered',
    });

    expect(duplicate).toBe(first);
    expect(store.list(1)).toHaveLength(1);
  });

  it('deduplicates common remote home path aliases', () => {
    const manual = store.add({ hostId: 1, label: 'git', path: '~/git' });
    const discovered = store.add({
      hostId: 1,
      label: 'git',
      path: '/home/alice/git',
      source: 'discovered',
    });
    const childManual = store.add({ hostId: 1, label: 'api', path: '$HOME/git/api' });
    const childDiscovered = store.add({
      hostId: 1,
      label: 'api',
      path: '/Users/alice/git/api',
      source: 'discovered',
    });

    expect(discovered).toBe(manual);
    expect(childDiscovered).toBe(childManual);
    expect(store.list(1).map((folder) => folder.path)).toEqual(['~/git', '$HOME/git/api']);
  });

  it('does not collapse arbitrary non-home paths', () => {
    store.add({ hostId: 1, label: 'srv git', path: '/srv/git' });
    store.add({ hostId: 1, label: 'home git', path: '~/git' });

    expect(store.list(1).map((folder) => folder.path)).toEqual(['/srv/git', '~/git']);
  });

  it('rejects updates that would duplicate an existing path alias', () => {
    const git = store.add({ hostId: 1, label: 'git', path: '~/git' });
    const projects = store.add({ hostId: 1, label: 'projects', path: '~/projects' });

    expect(store.update(projects, { path: '/home/alice/git' })).toBe(false);
    expect(store.get(git)).toMatchObject({ path: '~/git' });
    expect(store.get(projects)).toMatchObject({ path: '~/projects' });
  });

  it('allows updating a folder to an equivalent alias of its own path', () => {
    const git = store.add({ hostId: 1, label: 'git', path: '~/git' });

    expect(store.update(git, { path: '/home/alice/git' })).toBe(true);
    expect(store.list(1).map((folder) => folder.path)).toEqual(['/home/alice/git']);
  });
});
