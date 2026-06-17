/**
 * Unit tests for SessionTerminalMap.
 *
 * Verifies the one-terminal-per-session (host) invariants required by the
 * terminal-surface rework:
 *   - register/get/has/list basics
 *   - re-registering a host replaces (not duplicates) and disposes the old tab
 *   - delete disposes and removes
 *   - removeByTerminal removes without disposing (user-closed tab)
 *   - clear disposes everything
 *
 * Uses a fake terminal handle (a counter object) and a recording disposer so
 * disposal can be asserted without the VS Code API.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTerminalMap, tmuxSessionNameForHost, type SessionTerminalEntry } from '../../../src/terminal/session-terminal-map';

// ---------------------------------------------------------------------------
// Fake terminal handle + recording disposer
// ---------------------------------------------------------------------------

interface FakeTerminal {
  readonly id: number;
}

let nextHandleId = 1;
function makeHandle(): FakeTerminal {
  return { id: nextHandleId++ };
}

function makeEntry(hostId: number, terminal: FakeTerminal, hostLabel = `host-${hostId}`): SessionTerminalEntry<FakeTerminal> {
  return {
    hostId,
    hostLabel,
    terminal,
    sessionName: `pocketshell-${hostId}`,
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionTerminalMap', () => {
  let disposed: FakeTerminal[];
  let map: SessionTerminalMap<FakeTerminal>;

  beforeEach(() => {
    disposed = [];
    nextHandleId = 1;
    map = new SessionTerminalMap<FakeTerminal>((t) => {
      disposed.push(t);
    });
  });

  describe('register / get / has', () => {
    it('registers and retrieves an entry by host id', () => {
      const t = makeHandle();
      const entry = makeEntry(7, t);
      map.register(entry);

      expect(map.has(7)).toBe(true);
      expect(map.get(7)).toBe(entry);
    });

    it('reports size correctly', () => {
      expect(map.size).toBe(0);
      map.register(makeEntry(1, makeHandle()));
      map.register(makeEntry(2, makeHandle()));
      expect(map.size).toBe(2);
    });

    it('returns undefined for an unknown host', () => {
      expect(map.get(99)).toBeUndefined();
      expect(map.has(99)).toBe(false);
    });
  });

  describe('one-tab-per-session (no duplicates)', () => {
    it('re-registering a host replaces the entry and disposes the old terminal', () => {
      const first = makeHandle();
      const second = makeHandle();
      map.register(makeEntry(5, first));
      map.register(makeEntry(5, second));

      // Only one entry for host 5, and it is the new terminal.
      expect(map.size).toBe(1);
      expect(map.get(5)?.terminal).toBe(second);
      // The old terminal was disposed.
      expect(disposed).toEqual([first]);
      expect(disposed).not.toContain(second);
    });

    it('registering distinct hosts keeps all entries', () => {
      map.register(makeEntry(1, makeHandle()));
      map.register(makeEntry(2, makeHandle()));
      map.register(makeEntry(3, makeHandle()));
      expect(map.size).toBe(3);
      expect(disposed).toEqual([]);
    });
  });

  describe('delete', () => {
    it('deletes and disposes the entry for a host', () => {
      const t = makeHandle();
      map.register(makeEntry(4, t));
      const removed = map.delete(4);

      expect(removed).toBe(true);
      expect(map.has(4)).toBe(false);
      expect(disposed).toEqual([t]);
    });

    it('returns false when deleting an unknown host', () => {
      expect(map.delete(123)).toBe(false);
      expect(disposed).toEqual([]);
    });
  });

  describe('removeByTerminal', () => {
    it('removes an entry by terminal identity without disposing it', () => {
      const t = makeHandle();
      map.register(makeEntry(8, t));

      const removed = map.removeByTerminal(t);
      expect(removed).toBe(true);
      expect(map.has(8)).toBe(false);
      // The terminal was NOT disposed — VS Code already closed it.
      expect(disposed).toEqual([]);
    });

    it('returns false for an unknown terminal', () => {
      const t = makeHandle();
      expect(map.removeByTerminal(t)).toBe(false);
    });
  });

  describe('list', () => {
    it('returns a snapshot of all entries', () => {
      const e1 = makeEntry(1, makeHandle());
      const e2 = makeEntry(2, makeHandle());
      map.register(e1);
      map.register(e2);

      const all = map.list();
      expect(all.length).toBe(2);
      expect(all).toContain(e1);
      expect(all).toContain(e2);

      // Mutating the returned array does not affect the map.
      all.length = 0;
      expect(map.size).toBe(2);
    });
  });

  describe('clear', () => {
    it('disposes and removes every entry', () => {
      const t1 = makeHandle();
      const t2 = makeHandle();
      map.register(makeEntry(1, t1));
      map.register(makeEntry(2, t2));

      map.clear();

      expect(map.size).toBe(0);
      expect(disposed).toContain(t1);
      expect(disposed).toContain(t2);
      expect(disposed.length).toBe(2);
    });
  });
});

describe('tmuxSessionNameForHost', () => {
  it('prefixes and preserves a simple host label', () => {
    expect(tmuxSessionNameForHost('web-prod-01')).toBe('pocketshell-web-prod-01');
  });

  it('replaces characters that are illegal in tmux session names', () => {
    // tmux session names cannot contain ':' and must not start with '.'.
    expect(tmuxSessionNameForHost('user@10.0.0.1:2222')).toBe('pocketshell-user_10_0_0_1_2222');
  });

  it('trims leading/trailing separators produced by sanitization', () => {
    expect(tmuxSessionNameForHost('@host!')).toBe('pocketshell-host');
  });

  it('falls back to a default when the label sanitizes to empty', () => {
    expect(tmuxSessionNameForHost('!!!')).toBe('pocketshell-default');
    expect(tmuxSessionNameForHost('')).toBe('pocketshell-default');
  });

  it('is stable for the same input (reconnect attaches to the same tmux session)', () => {
    expect(tmuxSessionNameForHost('build-server')).toBe(tmuxSessionNameForHost('build-server'));
  });

  it('truncates very long labels', () => {
    const long = 'a'.repeat(200);
    const name = tmuxSessionNameForHost(long);
    expect(name.length).toBe('pocketshell-'.length + 40);
  });
});
