import { describe, expect, it } from 'vitest';
import { TmuxClientPool, switchFailureReason } from '../../src/main/ssh/TmuxClientPool';
import type { SshService } from '../../src/main/ssh/SshService';
import {
  SWITCH_CLIENT_NOT_READY_EXIT,
  SWITCH_NO_CLIENT_EXIT,
} from '../../src/shared/attachCommand';
import type { ExecResult, ShellId } from '../../src/shared/types';

/**
 * The pool's whole job is deciding, per session change, between three
 * outcomes: leave the pane alone, switch the client, or throw the client away
 * and join afresh. That decision is what these cover — the tmux commands
 * themselves are pinned in attachCommand.test.ts and exercised for real
 * against tmux in tests/integration/TmuxSwitch.integration.test.ts.
 *
 * The fake stands in for SshService rather than for ssh2: the pool only ever
 * touches four things on it (exec, openTrackedShell, shellClose, shellTracker),
 * and stubbing at that seam keeps the test about switching decisions instead of
 * about channel plumbing.
 */
interface FakeCall {
  kind: 'exec' | 'open' | 'close';
  detail: string;
}

function makeSsh(opts: { switchExit?: () => number; switchStderr?: string } = {}): {
  ssh: SshService;
  calls: FakeCall[];
  /** Ids handed out by openTrackedShell, in order. */
  opened: ShellId[];
  /** Kill a shell the way a dropped channel or a renderer close would. */
  forget(id: ShellId): void;
} {
  const calls: FakeCall[] = [];
  const opened: ShellId[] = [];
  const liveShells = new Set<ShellId>();
  let counter = 0;

  const ssh = {
    shellTracker: {
      get: (id: ShellId) => (liveShells.has(id) ? { id } : undefined),
    },
    exec: async (_connectionId: string, command: string): Promise<ExecResult> => {
      calls.push({ kind: 'exec', detail: command });
      const exitCode = opts.switchExit ? opts.switchExit() : 0;
      return { stdout: '', stderr: exitCode === 0 ? '' : (opts.switchStderr ?? ''), exitCode };
    },
    openTrackedShell: async (
      _connectionId: string,
      o: { command?: string },
    ): Promise<ShellId> => {
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
  } as unknown as SshService;

  return { ssh, calls, opened, forget: (id) => liveShells.delete(id) };
}

const sink = { onData: () => {}, onExit: () => {} };

describe('TmuxClientPool', () => {
  it('joins for the first session on a connection', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    const result = await pool.attach('c1', 'alpha', sink);

    expect(result.switched).toBe(false);
    expect(calls.filter((c) => c.kind === 'open')).toHaveLength(1);
    expect(calls[0]?.detail).toContain("tmuxctl 'alpha'");
    // And the join carries the handshake, or nothing later can switch.
    expect(calls[0]?.detail).toContain('set-environment -g PS_DESKTOP_TTY_');
  });

  it('switches instead of joining for every session after the first', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    const first = await pool.attach('c1', 'alpha', sink);
    const second = await pool.attach('c1', 'beta', sink);
    const third = await pool.attach('c1', 'gamma', sink);

    // The saving IS this: one PTY, three sessions.
    expect(calls.filter((c) => c.kind === 'open')).toHaveLength(1);
    expect(second.shellId).toBe(first.shellId);
    expect(third.shellId).toBe(first.shellId);
    expect(second.switched).toBe(true);
    expect(third.switched).toBe(true);
    expect(calls.filter((c) => c.kind === 'exec')).toHaveLength(2);
    // The name survives the `sh -lc` wrapper's quoting layer, so match on the
    // escaped form rather than re-deriving it.
    expect(calls.at(-1)?.detail).toContain("switch-client");
    expect(calls.at(-1)?.detail).toContain("=gamma");
  });

  it('does nothing at all when asked for the session already shown', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);
    const again = await pool.attach('c1', 'alpha', sink);

    expect(again.switched).toBe(true);
    expect(calls.filter((c) => c.kind === 'exec')).toHaveLength(0);
    expect(pool.currentSession('c1')).toBe('alpha');
  });

  it('falls back to a full join when the switch fails, closing the old client', async () => {
    // Every switch failure means the same thing — the client is gone, the
    // session is gone, or the handshake found nothing — and the answer to all
    // of them is the behaviour the app had before the pool existed.
    const { ssh, calls, opened } = makeSsh({ switchExit: () => 1 });
    const pool = new TmuxClientPool(ssh);

    const first = await pool.attach('c1', 'alpha', sink);
    const second = await pool.attach('c1', 'beta', sink);

    expect(second.switched).toBe(false);
    expect(second.shellId).not.toBe(first.shellId);
    expect(opened).toHaveLength(2);
    // The replaced client is closed HERE, not left for the renderer, so a
    // connection never ends up with two attached PTYs.
    expect(calls.some((c) => c.kind === 'close' && c.detail === first.shellId)).toBe(true);
    expect(calls.at(-1)?.detail).toContain("tmuxctl 'beta'");
  });

  it('recovers the fast path after one failed switch', async () => {
    let fail = true;
    const { ssh, calls } = makeSsh({
      switchExit: () => {
        const code = fail ? 1 : 0;
        fail = false;
        return code;
      },
    });
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);
    await pool.attach('c1', 'beta', sink); // fails -> re-joins
    const third = await pool.attach('c1', 'gamma', sink);

    // A single bad switch must not condemn the connection to re-joining
    // forever; the new client gets its own handshake and is used.
    expect(third.switched).toBe(true);
    expect(calls.filter((c) => c.kind === 'open')).toHaveLength(2);
  });

  it('joins again when the PTY it was holding has gone away', async () => {
    // The renderer closes the shell on unmount and a dropped connection closes
    // every shell on it, neither of which routes through the pool. Trusting the
    // map over the tracker would hand out a dead channel as a live client.
    const { ssh, calls, opened } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);
    ssh.shellClose(opened[0]!);

    const second = await pool.attach('c1', 'beta', sink);
    expect(second.switched).toBe(false);
    expect(calls.filter((c) => c.kind === 'exec')).toHaveLength(0);
    expect(pool.currentSession('c1')).toBe('beta');
  });

  it('keeps connections apart', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    const a = await pool.attach('c1', 'alpha', sink);
    const b = await pool.attach('c2', 'alpha', sink);

    expect(b.shellId).not.toBe(a.shellId);
    expect(b.switched).toBe(false);

    // Two windows on one host must not share a handshake variable, or the
    // second window's join would silently redirect the first window's switches.
    const [firstJoin, secondJoin] = calls.filter((c) => c.kind === 'open');
    const varOf = (d: string) => /PS_DESKTOP_TTY_[A-Za-z0-9_]+/.exec(d)?.[0];
    expect(varOf(firstJoin!.detail)).not.toBe(varOf(secondJoin!.detail));
  });

  it('reuses one handshake variable across a connection re-join', async () => {
    // Stable per connection so a re-join overwrites its own entry on the tmux
    // server rather than leaving a new one behind every time.
    const { ssh, calls } = makeSsh({ switchExit: () => 1 });
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);
    await pool.attach('c1', 'beta', sink); // switch fails -> re-join

    const joins = calls.filter((c) => c.kind === 'open');
    const varOf = (d: string) => /PS_DESKTOP_TTY_[A-Za-z0-9_]+/.exec(d)?.[0];
    expect(varOf(joins[0]!.detail)).toBe(varOf(joins[1]!.detail));
  });

  it('forgets a released connection', async () => {
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);
    pool.release('c1');

    expect(pool.currentSession('c1')).toBeNull();
    const after = await pool.attach('c1', 'beta', sink);
    expect(after.switched).toBe(false);
  });
});

/**
 * The settle budget, which is the fix for "switching makes no difference".
 *
 * A join publishes its tty as its FIRST act and only becomes a tmux client
 * once `tmuxctl` — Python — has started and exec'd `tmux attach`, ~330 ms
 * later on a loopback fixture and 1.5-2 s on a real host. In that window every
 * signal the pool can see says the fast path is available, and `switch-client`
 * alone knows better. The pool used to read that as "this host cannot switch",
 * close the PTY and re-join — which opened an identical window, so a user
 * clicking through sessions at ordinary speed never got a single switch and
 * every click paid the full re-attach. The budget is how the switch is told it
 * may wait for the client it is about to be handed.
 */
describe('TmuxClientPool — waiting out a join before declaring failure', () => {
  const waitOf = (command: string): number => {
    const tries = Number(/n=(\d+);/.exec(command)?.[1]);
    return Number.isFinite(tries) ? tries : -1;
  };

  it('lets the first switch after a join wait for the client', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);
    await pool.attach('c1', 'beta', sink);

    const exec = calls.find((c) => c.kind === 'exec');
    // More than the single look a zero budget buys: this switch is allowed to
    // outlast a join that has not finished attaching.
    expect(waitOf(exec!.detail)).toBeGreaterThan(1);
  });

  it('stops waiting once a switch has proved the client exists', async () => {
    // A client that has been switched once is known to tmux. A later switch
    // that cannot find it has lost it — the user detached from inside tmux —
    // and waiting for it back would only delay the re-join.
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);
    await pool.attach('c1', 'beta', sink); // proves the client
    await pool.attach('c1', 'gamma', sink);

    const execs = calls.filter((c) => c.kind === 'exec');
    expect(waitOf(execs[0]!.detail)).toBeGreaterThan(1);
    expect(waitOf(execs[1]!.detail)).toBe(1);
  });

  it('gives each fresh join its own budget', async () => {
    // The re-join a failed switch forces is a NEW client with a NEW window to
    // come up in. Carrying the old client's "proven" flag over would make the
    // very next switch fail for exactly the reason the budget exists to cover.
    let fail = true;
    const { ssh, calls } = makeSsh({
      switchExit: () => {
        const code = fail ? 1 : 0;
        fail = false;
        return code;
      },
    });
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);
    await pool.attach('c1', 'beta', sink); // fails -> re-joins
    await pool.attach('c1', 'gamma', sink);

    const execs = calls.filter((c) => c.kind === 'exec');
    expect(waitOf(execs.at(-1)!.detail)).toBeGreaterThan(1);
  });
});

describe('TmuxClientPool — making the fallback visible', () => {
  it("prints tmux own reason into the pane it re-joins", async () => {
    // "It still is not fast" was the entire bug report, because a fallback
    // that only writes a log line is a fallback nobody can report. The re-join
    // says why, in the terminal the user is already looking at.
    const { ssh, calls } = makeSsh({
      switchExit: () => 1,
      switchStderr: "can't find session: beta\n",
    });
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);
    await pool.attach('c1', 'beta', sink);

    const rejoin = calls.filter((c) => c.kind === 'open').at(-1)!.detail;
    expect(rejoin).toContain('[PocketShell]');
    expect(rejoin).toContain("can'\\''t find session: beta");
    expect(rejoin).toContain('re-joining');
  });

  it('explains the two codes tmux never says itself', async () => {
    for (const [exitCode, expected] of [
      [SWITCH_NO_CLIENT_EXIT, 'no tmux client'],
      [SWITCH_CLIENT_NOT_READY_EXIT, 'never came up'],
    ] as const) {
      expect(switchFailureReason(exitCode, '')).toContain(expected);
    }
    // And tmux's own words win wherever it supplied any, because they are what
    // a user can search for.
    expect(switchFailureReason(1, "can't find client: /dev/pts/19\n")).toBe(
      "can't find client: /dev/pts/19",
    );
  });

  it('leaves an ordinary first join unannotated', async () => {
    const { ssh, calls } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    await pool.attach('c1', 'alpha', sink);

    expect(calls.find((c) => c.kind === 'open')!.detail).not.toContain('[PocketShell] %s');
  });
});

describe('TmuxClientPool.isShowing', () => {
  it('fences a write meant for a session the client has left', async () => {
    // The composer's send is text, then a pause, then Enter. A session change
    // in that gap used to be harmless — the leftover writes went to a channel
    // nobody watched. With one shared client they would land in the new
    // session, so a named write has to be refusable.
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);

    const held = await pool.attach('c1', 'alpha', sink);
    expect(pool.isShowing(held.shellId, 'alpha')).toBe(true);

    await pool.attach('c1', 'beta', sink);
    expect(pool.isShowing(held.shellId, 'alpha')).toBe(false);
    expect(pool.isShowing(held.shellId, 'beta')).toBe(true);
  });

  it('permits a shell it does not own', async () => {
    // A bare `shell:open` PTY belongs to exactly one thing and cannot be
    // misrouted; refusing writes to it would break the pane it serves.
    const { ssh } = makeSsh();
    const pool = new TmuxClientPool(ssh);
    await pool.attach('c1', 'alpha', sink);

    expect(pool.isShowing('shell-not-ours', 'alpha')).toBe(true);
  });
});
