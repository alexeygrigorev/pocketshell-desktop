import { describe, expect, it } from 'vitest';
import { MAX_LIVE_CLIENTS, TmuxClientPool } from '../../src/main/ssh/TmuxClientPool';
import type { SshService } from '../../src/main/ssh/SshService';
import type { ExecResult, ShellId } from '../../src/shared/types';

/**
 * The pool's job is deciding, per attach, between two outcomes: hand back the
 * client this session already has, or open one — evicting another tab's client
 * first if the connection is out of SSH channels. That decision is what these
 * cover; the join command itself is pinned in attachCommand.test.ts and
 * exercised against real tmux in tests/integration/TmuxSessionTabs.
 *
 * WHAT CHANGED, AND WHY THESE TESTS LOOK DIFFERENT
 * ------------------------------------------------
 * This file used to assert the opposite invariant — "one PTY, three sessions" —
 * because the pool held a single client per connection and moved it with
 * `tmux switch-client`. Measured on a real host that cost p50 210 ms when it
 * worked and a full re-join when it did not, which was most of the time; the
 * numbers are in the header of TmuxClientPool. The pool now keeps a client per
 * session tab, so the property worth pinning is that a repeat attach touches
 * NOTHING, and the cost that has to stay bounded is channels rather than time.
 *
 * The fake stands in for SshService rather than for ssh2: the pool only ever
 * touches three things on it (openTrackedShell, shellClose, shellTracker), and
 * stubbing at that seam keeps the test about pooling rather than about channel
 * plumbing.
 */
interface FakeCall {
  kind: 'open' | 'close';
  detail: string;
}

function makeSsh(): {
  ssh: SshService;
  calls: FakeCall[];
  /** Ids handed out by openTrackedShell, in order. */
  opened: ShellId[];
  /** Kill a shell the way a dropped channel or a renderer close would. */
  forget(id: ShellId): void;
  /** Every command exec() was asked to run, in order. */
  execCalls: string[];
  /** Install what the NEXT exec() answers with (and the ones after it). */
  answerExecWith(result: ExecResult): void;
} {
  const calls: FakeCall[] = [];
  const opened: ShellId[] = [];
  const liveShells = new Set<ShellId>();
  const execCalls: string[] = [];
  let execResult: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
  let counter = 0;

  const ssh = {
    shellTracker: {
      get: (id: ShellId) => (liveShells.has(id) ? { id } : undefined),
    },
    openTrackedShell: async (_connectionId: string, o: { command?: string }): Promise<ShellId> => {
      const id = `shell-${++counter}`;
      calls.push({ kind: 'open', detail: o.command ?? '' });
      liveShells.add(id);
      opened.push(id);
      return id;
    },
    shellClose: (id: ShellId): void => {
      calls.push({ kind: 'close', detail: id });
      liveShells.delete(id);
    },
    exec: async (_connectionId: string, command: string): Promise<ExecResult> => {
      execCalls.push(command);
      return execResult;
    },
  } as unknown as SshService;

  return {
    ssh,
    calls,
    opened,
    forget: (id) => liveShells.delete(id),
    execCalls,
    answerExecWith: (result) => {
      execResult = result;
    },
  };
}

const sink = { onData: () => {}, onExit: () => {} };
const opens = (calls: FakeCall[]) => calls.filter((c) => c.kind === 'open');
const closes = (calls: FakeCall[]) => calls.filter((c) => c.kind === 'close');

describe('TmuxClientPool', () => {
  it('joins for a session it does not already hold', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    const result = await pool.attach('c1', 'alpha', sink);

    expect(result.switched).toBe(false);
    expect(opens(calls)).toHaveLength(1);
    expect(calls[0]?.detail).toContain("tmuxctl 'alpha'");
    // The handshake rides along so `list-clients` can be read back later.
    expect(calls[0]?.detail).toContain('set-environment -g PS_DESKTOP_TTY_');
  });

  it('gives every session its own client, so no tab shares a PTY', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    const a = await pool.attach('c1', 'alpha', sink);
    const b = await pool.attach('c1', 'beta', sink);
    const c = await pool.attach('c1', 'gamma', sink);

    // THIS is the property the whole design exists for. Three tabs, three
    // clients, so moving between them is a renderer visibility change and
    // never reaches the host at all.
    expect(new Set([a.shellId, b.shellId, c.shellId]).size).toBe(3);
    expect(opens(calls)).toHaveLength(3);
    expect(pool.liveSessions('c1').sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('does nothing at all when a session it already holds is asked for again', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    const first = await pool.attach('c1', 'alpha', sink);
    await pool.attach('c1', 'beta', sink);
    const again = await pool.attach('c1', 'alpha', sink);

    // No open, no close, no exec — the cost of returning to a tab is zero.
    expect(again.shellId).toBe(first.shellId);
    expect(again.switched).toBe(true);
    expect(opens(calls)).toHaveLength(2);
    expect(closes(calls)).toHaveLength(0);
  });

  it('joins again when the PTY it was holding has gone away', async () => {
    // The renderer closes the shell on unmount and a dropped connection closes
    // every shell on it, neither of which routes through the pool. Trusting the
    // map over the tracker would hand out a dead channel as a live client.
    const { ssh, calls, opened } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    const first = await pool.attach('c1', 'alpha', sink);
    ssh.shellClose(opened[0]!);

    const second = await pool.attach('c1', 'alpha', sink);
    expect(second.switched).toBe(false);
    expect(second.shellId).not.toBe(first.shellId);
    expect(opens(calls)).toHaveLength(2);
  });

  it('keeps connections apart', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    const a = await pool.attach('c1', 'alpha', sink);
    const b = await pool.attach('c2', 'alpha', sink);

    expect(b.shellId).not.toBe(a.shellId);
    // Two windows on one host must not share a handshake variable, or one
    // window's join would overwrite the other's entry and `list-clients` could
    // no longer say which client belonged to which.
    const varOf = (d: string) => /PS_DESKTOP_TTY_[A-Za-z0-9_]+/.exec(d)?.[0];
    const [first, second] = opens(calls);
    expect(varOf(first!.detail)).not.toBe(varOf(second!.detail));
  });

  it('gives each SESSION its own handshake variable, not each connection', async () => {
    // One variable per connection was right when a connection had one client.
    // With a client per tab, two tabs sharing a variable would have the second
    // join overwrite the first's tty, and nothing could tell the clients apart.
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);
    await pool.attach('c1', 'beta', sink);

    const varOf = (d: string) => /PS_DESKTOP_TTY_[A-Za-z0-9_]+/.exec(d)?.[0];
    const [a, b] = opens(calls);
    expect(varOf(a!.detail)).not.toBe(varOf(b!.detail));
  });

  it('reuses a session handshake variable across a re-join', async () => {
    // Stable per session so re-visiting an evicted tab overwrites its own entry
    // on the tmux server rather than leaving a new one behind every time.
    const { ssh, calls, opened } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);
    ssh.shellClose(opened[0]!);
    await pool.attach('c1', 'alpha', sink);

    const varOf = (d: string) => /PS_DESKTOP_TTY_[A-Za-z0-9_]+/.exec(d)?.[0];
    const [a, b] = opens(calls);
    expect(varOf(a!.detail)).toBe(varOf(b!.detail));
  });

  it('forgets a released connection', async () => {
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);
    pool.release('c1');

    expect(pool.liveSessions('c1')).toEqual([]);
    const after = await pool.attach('c1', 'alpha', sink);
    expect(after.switched).toBe(false);
  });
});

/**
 * The channel budget, which is the price of the whole design.
 *
 * Every live tab holds one SSH channel and `sshd`'s `MaxSessions` defaults to
 * 10 — measured against the fixture, channel 11 fails outright with
 * `Channel open failure: open failed`, and it fails for every OTHER thing the
 * app needs a channel for too: each `exec`, SFTP for the Files tabs, each
 * `tail`. So the pool caps itself well below the ceiling and evicts rather
 * than letting an unrelated feature break with an error pointing nowhere near
 * the cause.
 */
describe('TmuxClientPool — staying under the SSH channel ceiling', () => {
  it('never holds more than the budget, however many tabs are opened', async () => {
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    for (let i = 0; i < MAX_LIVE_CLIENTS + 4; i++) {
      await pool.attach('c1', `s${i}`, sink);
    }

    expect(pool.liveSessions('c1')).toHaveLength(MAX_LIVE_CLIENTS);
  });

  it('evicts the LEAST RECENTLY USED tab, not the oldest', async () => {
    // The tabs a user moves between are the ones that must stay instant, and
    // those are the recently used ones — which is not the same set as the
    // recently opened ones. `alpha` is opened first and would lose under an
    // oldest-first rule, but it is the tab still being used.
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    for (let i = 0; i < MAX_LIVE_CLIENTS; i++) {
      await pool.attach('c1', `s${i}`, sink);
    }
    // Touch the oldest so it becomes the most recently used.
    await pool.attach('c1', 's0', sink);
    await pool.attach('c1', 'newcomer', sink);

    const live = pool.liveSessions('c1');
    expect(live).toContain('s0');
    expect(live).toContain('newcomer');
    expect(live).not.toContain('s1');
  });

  it('closes the evicted PTY rather than leaking the channel', async () => {
    const { ssh, calls, opened } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    for (let i = 0; i < MAX_LIVE_CLIENTS + 1; i++) {
      await pool.attach('c1', `s${i}`, sink);
    }

    // The first tab opened is the least recently used, so it is the victim.
    expect(closes(calls).map((c) => c.detail)).toEqual([opened[0]]);
  });

  it('re-joins an evicted tab when the user goes back to it', async () => {
    // Eviction costs the tab its channel and nothing else: the tmux SESSION is
    // server-side, so the re-join finds it exactly as it was.
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    const first = await pool.attach('c1', 'alpha', sink);
    for (let i = 0; i < MAX_LIVE_CLIENTS; i++) {
      await pool.attach('c1', `s${i}`, sink);
    }
    expect(pool.liveSessions('c1')).not.toContain('alpha');

    const back = await pool.attach('c1', 'alpha', sink);
    expect(back.switched).toBe(false);
    expect(back.shellId).not.toBe(first.shellId);
    expect(pool.liveSessions('c1')).toContain('alpha');
  });

  it('counts only channels that are still live, so a dead tab makes room', async () => {
    // A shell the renderer closed is not a channel. Counting it would evict a
    // healthy tab to make room that already existed.
    const { ssh, calls, opened } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    for (let i = 0; i < MAX_LIVE_CLIENTS; i++) {
      await pool.attach('c1', `s${i}`, sink);
    }
    ssh.shellClose(opened[0]!);
    const closesBefore = closes(calls).length;

    await pool.attach('c1', 'newcomer', sink);

    // The dead one made the room; nothing else was closed to find it.
    expect(closes(calls)).toHaveLength(closesBefore);
    expect(pool.liveSessions('c1')).toContain('newcomer');
    expect(pool.liveSessions('c1')).toHaveLength(MAX_LIVE_CLIENTS);
  });
});

/**
 * The composer's fence, which a client per tab makes exact.
 *
 * A composer send is text, a pause, then Enter. Under a shared client a user
 * who hit Send and immediately clicked another tab could have the Enter submit
 * a stranger's pane, because the shell's MEANING changed mid-send. A per-tab
 * client cannot change meaning, so the fence stops being a race guard and
 * becomes an ordinary assertion about a stale id.
 */
describe('TmuxClientPool — the input fence', () => {
  it('lets a session write to its own shell', async () => {
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);
    const a = await pool.attach('c1', 'alpha', sink);
    await pool.attach('c1', 'beta', sink);

    expect(pool.isShowing(a.shellId, 'alpha')).toBe(true);
  });

  it('refuses a write aimed at a session that is not this shell', async () => {
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);
    const a = await pool.attach('c1', 'alpha', sink);
    await pool.attach('c1', 'beta', sink);

    expect(pool.isShowing(a.shellId, 'beta')).toBe(false);
  });

  it('cannot be made stale by opening another tab', async () => {
    // The regression the fence was built for: under a shared client this same
    // sequence turned `alpha`'s shell into `beta`'s, so a send in flight landed
    // in the wrong pane. Now it simply cannot.
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);
    const a = await pool.attach('c1', 'alpha', sink);

    await pool.attach('c1', 'beta', sink);
    await pool.attach('c1', 'gamma', sink);

    expect(pool.isShowing(a.shellId, 'alpha')).toBe(true);
    expect(pool.sessionForShell(a.shellId)).toBe('alpha');
  });

  it('passes through a shell it never opened', async () => {
    // A bare `shell:open` pane cannot be misrouted, so it is not fenced.
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);
    await pool.attach('c1', 'alpha', sink);

    expect(pool.isShowing('shell-not-ours', 'anything')).toBe(true);
  });
});

/**
 * A rename moves the session under a live client. The client is unaffected —
 * tmux clients follow a session by id — but every map keyed on the NAME has to
 * move with it, or the tab's own composer sends start being rejected as a
 * stranger's and the renamed tab costs a re-join beside the client already
 * showing it.
 */
describe('TmuxClientPool — renames', () => {
  it('re-keys a live client so the tab stays instant', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);
    const before = await pool.attach('c1', 'git-foo-import', sink);

    expect(pool.renamed('c1', 'git-foo-import', 'git-foo-staging')).toBe(true);

    const after = await pool.attach('c1', 'git-foo-staging', sink);
    expect(after.shellId).toBe(before.shellId);
    expect(after.switched).toBe(true);
    expect(opens(calls)).toHaveLength(1);
  });

  it('moves the fence with the name', async () => {
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);
    const held = await pool.attach('c1', 'old', sink);

    pool.renamed('c1', 'old', 'new');

    expect(pool.isShowing(held.shellId, 'new')).toBe(true);
    expect(pool.isShowing(held.shellId, 'old')).toBe(false);
  });

  it('moves the handshake token too, so a re-join reuses its variable', async () => {
    const { ssh, calls, opened } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'old', sink);
    pool.renamed('c1', 'old', 'new');
    ssh.shellClose(opened[0]!);
    await pool.attach('c1', 'new', sink);

    const varOf = (d: string) => /PS_DESKTOP_TTY_[A-Za-z0-9_]+/.exec(d)?.[0];
    const [a, b] = opens(calls);
    expect(varOf(a!.detail)).toBe(varOf(b!.detail));
  });

  it('is an ordinary no-op for a session this connection does not hold', async () => {
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);
    await pool.attach('c1', 'alpha', sink);

    expect(pool.renamed('c1', 'somebody-else', 'whatever')).toBe(false);
  });
});

/**
 * A kill is the mirror image of a rename, and the
 * pool half matters MORE: a rename leaves a live client pointing at a live
 * session under the wrong key, a kill leaves one pointing at nothing at all.
 */
describe('TmuxClientPool — kills', () => {
  it('closes the PTY and forgets the client, so the next attach re-joins', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);
    const before = await pool.attach('c1', 'git-foo', sink);

    expect(pool.killed('c1', 'git-foo')).toBe(true);
    expect(closes(calls).map((c) => c.detail)).toEqual([before.shellId]);

    // The record has to go SYNCHRONOUSLY with the kill. Waiting for the far end
    // to detach and `shell:exited` to arrive would leave a window in which
    // `attach` hands a caller a client for a session that no longer exists.
    const after = await pool.attach('c1', 'git-foo', sink);
    expect(after.switched).toBe(false);
    expect(after.shellId).not.toBe(before.shellId);
    expect(opens(calls)).toHaveLength(2);
  });

  it('stops fencing composer sends against the dead name', async () => {
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);
    const held = await pool.attach('c1', 'git-foo', sink);

    pool.killed('c1', 'git-foo');

    expect(pool.sessionForShell(held.shellId)).toBeNull();
    expect(pool.liveSessions('c1')).toEqual([]);
  });

  it('DROPS the handshake token, unlike a rename which moves it', async () => {
    // A rename keeps the same session and wants the same tmux variable. A kill
    // ends it — and a later session that reuses the name is a DIFFERENT session,
    // which `sessions create` produces routinely because it derives the name
    // from the folder. It must not inherit the dead one's tty rendezvous.
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'git-foo', sink);
    pool.killed('c1', 'git-foo');
    await pool.attach('c1', 'git-foo', sink);

    const varOf = (d: string): string | undefined =>
      /PS_DESKTOP_TTY_[A-Za-z0-9_]+/.exec(d)?.[0];
    const [a, b] = opens(calls);
    expect(varOf(a!.detail)).not.toBe(varOf(b!.detail));
  });

  it('is an ordinary no-op for a session this connection never held', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);
    await pool.attach('c1', 'alpha', sink);

    expect(pool.killed('c1', 'somebody-else')).toBe(false);
    expect(closes(calls)).toHaveLength(0);
  });

  it('forgets a client whose channel had already gone, without closing twice', async () => {
    // Eviction, or a dropped link. `shellClose` on a stale id would be a no-op
    // anyway; what matters is that the record still goes.
    // `forget` is kept on the harness rather than destructured: it is declared
    // as a METHOD on the returned type, and pulling a method off its object is
    // what `@typescript-eslint/unbound-method` exists to catch.
    const harness = makeSsh();
    const pool = new TmuxClientPool(harness.ssh);
    await pool.attach('c1', 'git-foo', sink);
    harness.forget(harness.opened[0]!);

    expect(pool.killed('c1', 'git-foo')).toBe(false);
    expect(closes(harness.calls)).toHaveLength(0);
    expect(pool.liveSessions('c1')).toEqual([]);
  });
});

/**
 * The read-only half of `redraw`: asking tmux what size IT thinks the window
 * is, so TerminalView can notice the stale-geometry failure instead of waiting
 * for a human to reach for the menu item.
 *
 * The contract that matters here is what it costs: one exec for a shell the
 * pool holds, NOTHING AT ALL for a shell it does not (bare shells are normal,
 * and an exec spent discovering that would burn the reconcile interval's
 * headroom), and null rather than a throw whenever tmux cannot answer.
 */
describe('TmuxClientPool — the geometry probe', () => {
  const varNameOf = (d: string): string | undefined =>
    /PS_DESKTOP_TTY_[A-Za-z0-9_]+/.exec(d)?.[0];

  it('addresses our client by its tty and parses the answer', async () => {
    const harness = makeSsh();
    const pool = new TmuxClientPool(harness.ssh);
    const joined = await pool.attach('c1', 'alpha', sink);
    harness.answerExecWith({ stdout: '132 41\n', stderr: '', exitCode: 0 });

    await expect(pool.windowSize(joined.shellId)).resolves.toEqual({ cols: 132, rows: 41 });

    // The join published THIS session's tty under a global-environment
    // variable; the probe must recover THAT variable (so the question is about
    // our client, never whoever else is attached) and ask for the WINDOW's
    // size, which is the quantity `window-size latest` moves under us.
    expect(harness.execCalls).toHaveLength(1);
    // pathAwareCommand wraps in `/bin/sh -lc '...'` and spells every inner
    // quote as `'\''`; undo that layer so the fragments can be read plainly.
    const command = harness.execCalls[0]!.replace(/'\\''/g, "'");
    expect(command).toContain(varNameOf(harness.calls[0]!.detail)!);
    expect(command).toContain(`sed -n 's/^${varNameOf(harness.calls[0]!.detail)}=//p'`);
    expect(command).toContain(`display-message -p -t "$tty" '#{window_width} #{window_height}'`);
  });

  it('answers null for a shell this pool never opened, without spending an exec', async () => {
    // A bare-shell tab probes too; discovering "not mine" has to be free, or
    // every pane without a tmux client pays a round trip per tick forever.
    const harness = makeSsh();
    const pool = new TmuxClientPool(harness.ssh);
    await pool.attach('c1', 'alpha', sink);

    await expect(pool.windowSize('shell-not-ours')).resolves.toBeNull();
    expect(harness.execCalls).toHaveLength(0);
  });

  it('answers null when the handshake variable or the client is gone', async () => {
    // `[ -n "$tty" ]` failing leaves tmux unasked and exits non-zero; a client
    // detached since the join reads the same from here.
    const harness = makeSsh();
    const pool = new TmuxClientPool(harness.ssh);
    const joined = await pool.attach('c1', 'alpha', sink);
    harness.answerExecWith({ stdout: '', stderr: '', exitCode: 1 });

    await expect(pool.windowSize(joined.shellId)).resolves.toBeNull();
  });

  it('answers null when tmux says something unparseable', async () => {
    // Defensive output handling — a probe whose caller had to try/catch would
    // push the cost of "no answer" onto every tick instead of this one point.
    const harness = makeSsh();
    const pool = new TmuxClientPool(harness.ssh);
    const joined = await pool.attach('c1', 'alpha', sink);
    harness.answerExecWith({ stdout: 'not-a-number\n', stderr: '', exitCode: 0 });

    await expect(pool.windowSize(joined.shellId)).resolves.toBeNull();
  });
});
