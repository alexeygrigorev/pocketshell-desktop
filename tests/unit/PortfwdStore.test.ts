import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MemoryBackend,
  PortfwdStore,
  createElectronBackend,
  hostKeyFor,
  sanitiseState,
  type PortfwdBackend,
  type PortfwdSchema,
} from '@main/portfwd/PortfwdStore';

/**
 * Persistence rules ported from `_load_port_names` / `_save_port_names`
 * (`forwarder.py:30-56`, `:999-1006`). The Python persists only names, and
 * its remaps die with the process despite the docstring; here everything
 * survives a restart, so the sanitisation has to be bulletproof — a corrupt
 * store must degrade to empty, never throw on the connect path.
 */

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function store(): PortfwdStore {
  return new PortfwdStore(new MemoryBackend());
}

/** A backend serving one canned document and recording writes. */
function fakeBackend(doc: unknown): { backend: PortfwdBackend; writes: PortfwdSchema[] } {
  const writes: PortfwdSchema[] = [];
  return {
    backend: {
      read: () => doc,
      write: (next) => writes.push(next),
    },
    writes,
  };
}

describe('hostKeyFor', () => {
  it('prefers the ssh-config alias, like the Python keys on host_alias', () => {
    expect(hostKeyFor({ hostAlias: 'prod-web', user: 'root', host: '1.2.3.4', port: 22 })).toBe(
      'prod-web',
    );
  });

  it('falls back to user@host:port until hostAlias is threaded through', () => {
    expect(hostKeyFor({ user: 'alexey', host: 'example.com', port: 2222 })).toBe(
      'alexey@example.com:2222',
    );
    expect(hostKeyFor({ hostAlias: '   ', user: 'a', host: 'b', port: 22 })).toBe('a@b:22');
    expect(hostKeyFor({ hostAlias: null, user: 'a', host: 'b', port: 22 })).toBe('a@b:22');
  });
});

describe('sanitiseState', () => {
  it('treats anything that is not an object as empty', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      expect(sanitiseState(bad)).toEqual({
        names: {},
        remaps: {},
        forceOn: [],
        forceOff: [],
        autoEnabled: false,
      });
    }
  });

  it('drops non-numeric port keys and empty names on read', () => {
    const state = sanitiseState({
      names: { '8080': 'admin UI', notaport: 'x', '9090': '   ', '9091': 42 },
      remaps: { '19840': 3000, '19841': 'nope', bad: 1, '19842': 99_999 },
    });
    expect(state.names).toEqual({ '8080': 'admin UI' });
    expect(state.remaps).toEqual({ '19840': 3000 });
  });

  it('sorts and dedupes the intent lists, dropping invalid ports', () => {
    const state = sanitiseState({ forceOn: [9, 3, 3, -1, 70_000, 'x'], forceOff: 'nope' });
    expect(state.forceOn).toEqual([3, 9]);
    expect(state.forceOff).toEqual([]);
  });
});

describe('PortfwdStore names', () => {
  it('round-trips a friendly name per host', () => {
    const s = store();
    s.setName('prod-web', 8080, 'admin UI');
    s.setName('staging', 8080, 'staging admin');
    expect(s.read('prod-web').names).toEqual({ '8080': 'admin UI' });
    expect(s.read('staging').names).toEqual({ '8080': 'staging admin' });
  });

  it('trims, and an empty name DELETES the entry', () => {
    const s = store();
    s.setName('h', 8080, '  admin UI  ');
    expect(s.read('h').names['8080']).toBe('admin UI');
    s.setName('h', 8080, '   ');
    expect(s.read('h').names).toEqual({});
    s.setName('h', 8080, 'back');
    s.setName('h', 8080, null);
    expect(s.read('h').names).toEqual({});
  });

  it('removes a host entirely once its state is empty again', () => {
    const s = store();
    s.setName('h', 8080, 'x');
    expect(s.hostKeys()).toEqual(['h']);
    s.setName('h', 8080, null);
    expect(s.hostKeys()).toEqual([]);
  });

  it('re-reads the whole document per write so two hosts cannot clobber', () => {
    const { backend, writes } = fakeBackend({
      hosts: { other: { names: { '22': 'jump box' } } },
      version: 1,
    });
    new PortfwdStore(backend).setName('mine', 8080, 'admin');
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0]!.hosts).sort()).toEqual(['mine', 'other']);
    expect(writes[0]!.hosts.other!.names).toEqual({ '22': 'jump box' });
  });
});

describe('PortfwdStore remaps and intents', () => {
  it('sets and clears a remap', () => {
    const s = store();
    s.setRemap('h', 19840, 3000);
    expect(s.read('h').remaps).toEqual({ '19840': 3000 });
    s.clearRemap('h', 19840);
    expect(s.read('h').remaps).toEqual({});
  });

  it('keeps a port in exactly one intent list', () => {
    const s = store();
    s.setIntent('h', 8080, 'force-on');
    expect(s.read('h')).toMatchObject({ forceOn: [8080], forceOff: [] });
    s.setIntent('h', 8080, 'force-off');
    expect(s.read('h')).toMatchObject({ forceOn: [], forceOff: [8080] });
    s.setIntent('h', 8080, null);
    expect(s.read('h')).toMatchObject({ forceOn: [], forceOff: [] });
  });

  it('remembers whether auto-forward was left running', () => {
    const s = store();
    expect(s.read('h').autoEnabled).toBe(false);
    s.setAutoEnabled('h', true);
    expect(s.read('h').autoEnabled).toBe(true);
    s.setAutoEnabled('h', false);
    expect(s.hostKeys()).toEqual([]); // fully default again -> host dropped
  });
});

describe('PortfwdStore resilience', () => {
  it('returns empty state for a corrupt document instead of throwing', () => {
    for (const doc of [null, 'garbage', 42, { hosts: 'not a map' }, { nope: true }]) {
      const s = new PortfwdStore(fakeBackend(doc).backend);
      expect(s.read('h').names).toEqual({});
      expect(s.hostKeys()).toEqual([]);
    }
  });

  it('survives a backend that throws on read or write', () => {
    const s = new PortfwdStore({
      read: () => {
        throw new Error('EACCES');
      },
      write: () => {
        throw new Error('EROFS');
      },
    });
    expect(() => s.setName('h', 8080, 'x')).not.toThrow();
    expect(s.read('h').names).toEqual({});
  });

  it('sanitises a stored document that has drifted from the schema', () => {
    const { backend } = fakeBackend({
      hosts: { h: { names: { '8080': 'ok', junk: 'drop' }, forceOn: [1, 'x'] } },
      version: 1,
    });
    expect(new PortfwdStore(backend).read('h')).toEqual({
      names: { '8080': 'ok' },
      remaps: {},
      forceOn: [1],
      forceOff: [],
      autoEnabled: false,
    });
  });
});

describe('electron-store backend', () => {
  it('persists to disk and reads back through a fresh store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portfwd-store-'));
    tempDirs.push(dir);

    const first = new PortfwdStore(createElectronBackend({ cwd: dir }));
    first.setName('prod-web', 8080, 'admin UI');
    first.setRemap('prod-web', 19840, 3000);
    first.setIntent('prod-web', 5432, 'force-off');

    // A second process/window reading the same file must see it all — this is
    // the property the Python lacks: its remaps die with the process.
    const second = new PortfwdStore(createElectronBackend({ cwd: dir }));
    expect(second.read('prod-web')).toEqual({
      names: { '8080': 'admin UI' },
      remaps: { '19840': 3000 },
      forceOn: [],
      forceOff: [5432],
      autoEnabled: false,
    });
  });

  it('PortfwdStore.default() degrades to memory outside an Electron app', () => {
    // `app.getPath('userData')` does not exist here, so the constructor
    // throws; forwarding must not depend on persistence being available.
    const s = PortfwdStore.default();
    s.setName('h', 8080, 'x');
    expect(s.read('h').names).toEqual({ '8080': 'x' });
  });
});
