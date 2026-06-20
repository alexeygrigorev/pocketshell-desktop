/**
 * Unit tests for SessionTerminalMap.
 *
 * Verifies the one-terminal-per-(host, tmux session) invariants required by the
 * terminal-surface rework + #103 (1 SSH connection + N tmux sessions per host):
 *   - register/get/has/list basics
 *   - re-registering a (host, session) replaces (not duplicates) + disposes old
 *   - DISTINCT sessions on the SAME host coexist (multi-session per host) — #103
 *   - delete disposes and removes (by host, session)
 *   - removeByTerminal removes without disposing (user-closed tab)
 *   - clear disposes everything
 *   - single-session (sessionName omitted) get/has back-compat
 *
 * Uses a fake terminal handle (a counter object) and a recording disposer so
 * disposal can be asserted without the VS Code API.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTerminalMap, sessionTerminalKey, tmuxSessionNameForHost, type SessionTerminalEntry } from '../../../src/terminal/session-terminal-map';

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

function makeEntry(
  hostId: number,
  terminal: FakeTerminal,
  sessionName = `pocketshell-${hostId}`,
  hostLabel = `host-${hostId}`,
): SessionTerminalEntry<FakeTerminal> {
  return {
    hostId,
    hostLabel,
    terminal,
    sessionName,
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

  describe('register / get / has (single session)', () => {
    it('registers and retrieves an entry by (host, session)', () => {
      const t = makeHandle();
      const entry = makeEntry(7, t);
      map.register(entry);

      expect(map.has(7, 'pocketshell-7')).toBe(true);
      expect(map.get(7, 'pocketshell-7')).toBe(entry);
    });

    it('reports size correctly', () => {
      expect(map.size).toBe(0);
      map.register(makeEntry(1, makeHandle()));
      map.register(makeEntry(2, makeHandle()));
      expect(map.size).toBe(2);
    });

    it('returns undefined for an unknown (host, session)', () => {
      expect(map.get(99, 'nope')).toBeUndefined();
      expect(map.has(99, 'nope')).toBe(false);
    });
  });

  describe('one-tab-per-(host, session) (no duplicates)', () => {
    it('re-registering a (host, session) replaces the entry and disposes the old terminal', () => {
      const first = makeHandle();
      const second = makeHandle();
      map.register(makeEntry(5, first, 'pocketshell-5'));
      map.register(makeEntry(5, second, 'pocketshell-5'));

      // Only one entry for (5, pocketshell-5), and it is the new terminal.
      expect(map.size).toBe(1);
      expect(map.get(5, 'pocketshell-5')?.terminal).toBe(second);
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

  describe('multi-session per host (#103 parity)', () => {
    it('allows MULTIPLE distinct sessions on the SAME host', () => {
      const defaultSession = makeEntry(5, makeHandle(), 'pocketshell-5');
      const devSession = makeEntry(5, makeHandle(), 'git-project');
      const agentSession = makeEntry(5, makeHandle(), 'claude-work');

      map.register(defaultSession);
      map.register(devSession);
      map.register(agentSession);

      // Three distinct (host, session) entries on host 5.
      expect(map.size).toBe(3);
      expect(map.has(5, 'pocketshell-5')).toBe(true);
      expect(map.has(5, 'git-project')).toBe(true);
      expect(map.has(5, 'claude-work')).toBe(true);
      // Nothing disposed — they coexist.
      expect(disposed).toEqual([]);
    });

    it('re-registering ONE session on a multi-session host only replaces that session', () => {
      const t1 = makeHandle();
      const t2 = makeHandle();
      const t2Replacement = makeHandle();
      const t3 = makeHandle();

      map.register(makeEntry(5, t1, 'pocketshell-5'));
      map.register(makeEntry(5, t2, 'git-project'));
      map.register(makeEntry(5, t3, 'claude-work'));

      // Replace ONLY the git-project session.
      map.register(makeEntry(5, t2Replacement, 'git-project'));

      expect(map.size).toBe(3);
      expect(map.get(5, 'git-project')?.terminal).toBe(t2Replacement);
      // The other two sessions are untouched.
      expect(map.get(5, 'pocketshell-5')?.terminal).toBe(t1);
      expect(map.get(5, 'claude-work')?.terminal).toBe(t3);
      // Only the replaced git-project terminal was disposed.
      expect(disposed).toEqual([t2]);
    });

    it('listForHost returns only the entries for one host', () => {
      map.register(makeEntry(5, makeHandle(), 'pocketshell-5'));
      map.register(makeEntry(5, makeHandle(), 'git-project'));
      map.register(makeEntry(7, makeHandle(), 'pocketshell-7'));

      const host5 = map.listForHost(5);
      expect(host5.length).toBe(2);
      expect(host5.every((entry) => entry.hostId === 5)).toBe(true);
    });
  });

  describe('single-session back-compat (sessionName omitted)', () => {
    it('get(hostId) returns the host first entry', () => {
      const first = makeEntry(5, makeHandle(), 'pocketshell-5');
      map.register(first);
      map.register(makeEntry(5, makeHandle(), 'git-project'));

      expect(map.get(5)?.terminal).toBe(first.terminal);
    });

    it('has(hostId) is true when the host has any entry', () => {
      map.register(makeEntry(5, makeHandle(), 'git-project'));
      expect(map.has(5)).toBe(true);
      expect(map.has(99)).toBe(false);
    });
  });

  describe('delete', () => {
    it('deletes and disposes the entry for a (host, session)', () => {
      const t = makeHandle();
      map.register(makeEntry(4, t, 'pocketshell-4'));
      const removed = map.delete(4, 'pocketshell-4');

      expect(removed).toBe(true);
      expect(map.has(4, 'pocketshell-4')).toBe(false);
      expect(disposed).toEqual([t]);
    });

    it('deleting one session does not affect other sessions on the same host', () => {
      const t1 = makeHandle();
      const t2 = makeHandle();
      map.register(makeEntry(4, t1, 'pocketshell-4'));
      map.register(makeEntry(4, t2, 'git-project'));

      const removed = map.delete(4, 'pocketshell-4');

      expect(removed).toBe(true);
      expect(map.has(4, 'pocketshell-4')).toBe(false);
      expect(map.has(4, 'git-project')).toBe(true);
      expect(disposed).toEqual([t1]);
    });

    it('returns false when deleting an unknown (host, session)', () => {
      expect(map.delete(123, 'nope')).toBe(false);
      expect(disposed).toEqual([]);
    });
  });

  describe('removeByTerminal', () => {
    it('removes an entry by terminal identity without disposing it', () => {
      const t = makeHandle();
      map.register(makeEntry(8, t, 'pocketshell-8'));

      const removed = map.removeByTerminal(t);
      expect(removed).toBe(true);
      expect(map.has(8, 'pocketshell-8')).toBe(false);
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

describe('sessionTerminalKey', () => {
  it('builds a composite hostId:sessionName key', () => {
    expect(sessionTerminalKey(7, 'git-project')).toBe('7:git-project');
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
