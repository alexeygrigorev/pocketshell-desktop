import { randomBytes } from 'node:crypto';
import type { ShellId } from '../../shared/types.js';
import { clientTtyVar, sessionAttachCommand } from '../../shared/attachCommand.js';
import type { SshService } from './SshService.js';
import { log } from '../log.js';

/**
 * One attached tmux client PER SESSION TAB, kept alive for as long as the tab
 * is open, so that returning to a tab costs nothing at all.
 *
 * ## The problem, and why the previous answer was the wrong shape
 *
 * Selecting a session originally meant: open a second SSH channel, request a
 * PTY, wait for a login shell, and run `tmuxctl <name>` in it. Every part of
 * that is per-switch cost. The first fix (commit 516b488) held ONE client per
 * connection and moved it with `tmux switch-client`, which replaced ~250 ms of
 * host time with ~10 ms of exec — measured on a loopback Docker fixture.
 *
 * Measured on a REAL host, over a real link, out of the user's own log, that
 * trade did not survive contact:
 *
 *     switch that succeeded      p50 210 ms, max 425 ms   (8 of 41 attempts)
 *     switch that failed         140 ms - 4.4 s, THEN a full re-join
 *
 * Two costs the loopback benchmark could not show. First, a switch is an SSH
 * exec channel, and a channel is round trips: measured under netem the switch
 * tracks the link almost exactly — 15 ms at 0 RTT, 43 ms at 30 ms, 111 ms at
 * 100 ms. Second, `switch-client` makes tmux repaint every cell of the new
 * session down the PTY: 10.7 KB for one dense 200x50 screen, which is another
 * ~8 ms at 30 ms RTT and a visible wipe-and-redraw at any latency.
 *
 * Neither cost is a defect in the switch. They are what a switch IS. No amount
 * of tuning makes a remote repaint feel like changing tabs in an editor,
 * because the editor is not asking another machine for the tab's contents.
 *
 * ## The shape now
 *
 * A tab that has been opened keeps its own PTY, its own tmux client and its own
 * xterm, all mounted, for as long as the workspace is open. Switching tabs is
 * therefore a renderer visibility change and NOTHING ELSE: no SSH, no exec, no
 * redraw, no bytes. That is the property the user asked for by name — "the same
 * as VS Code when I switch between files" — and it is not reachable by making
 * the switch faster, only by not switching.
 *
 * tmux is built for this. Many clients may attach to one server, each on its
 * own session, and a session's window is sized from its own attached clients
 * (`window-size latest` by default in tmux 3.x), so one tab's geometry cannot
 * disturb another's.
 *
 * ## What it costs: SSH channels, and the ceiling is real
 *
 * Every live tab holds one channel. `sshd`'s `MaxSessions` defaults to 10, and
 * it is a HARD ceiling — measured against the fixture, channel 11 fails with
 * `Channel open failure: open failed`, and it fails for everything else the app
 * needs a channel for too (every `exec`, every SFTP operation, every tail).
 *
 * So the pool keeps at most {@link MAX_LIVE_CLIENTS} clients per connection and
 * evicts the least recently used one beyond that. The budget is per CONNECTION
 * but the demand is per FOLDER WORKSPACE — only the open workspace's tabs are
 * mounted — and the measurement in docs/WORKSPACE.md §1 puts a real folder at
 * one to four sessions, so eviction is a bound rather than a routine event.
 *
 * Eviction closes the PTY and nothing else. A tmux SESSION lives in the tmux
 * server, not in our client, so an evicted tab loses no state whatsoever: the
 * next visit re-joins and gets the session exactly as it was. The renderer
 * learns through the ordinary `shell:exited` it already handles.
 *
 * ## What it costs: the first open of each tab
 *
 * A tab that has never been opened still pays the full join — a PTY, a login
 * shell and `tmuxctl`, which is Python and is ~150 ms on the fixture and 1.5-2 s
 * on the user's host. That cost is unchanged, but it is now paid ONCE PER TAB
 * instead of once per switch, so it amortises to nothing over a working
 * session. It is also the largest thing left; see the note on
 * {@link sessionAttachCommand} about what a raw `tmux attach-session` would
 * save, which is a separate decision from this one.
 *
 * ## What it costs on the host
 *
 * One tmux global-environment variable per (connection, session), left behind
 * on the tmux server when the app goes away — the same leak the shared client
 * had, bounded by distinct sessions opened rather than by joins, because the
 * token is stable per session so a re-join overwrites its own entry. The
 * variable is now only a diagnostic rendezvous: nothing reads it back since the
 * pool stopped moving clients between sessions. It is kept because it is the
 * one way to tell OUR client from the user's own terminal in `list-clients`,
 * which is what makes a bug report about a stray client readable.
 */

/** Callbacks for a shell this pool opens. Both carry the id they belong to. */
export interface AttachSessionOptions {
  cols?: number;
  rows?: number;
  /**
   * Bytes from the PTY. The {@link ShellId} is passed rather than closed over
   * by the caller because a fresh attach only learns its id when
   * `openTrackedShell` resolves, and the first bytes can beat that resolution.
   */
  onData: (shellId: ShellId, data: Buffer) => void;
  onExit: (shellId: ShellId, exitCode: number) => void;
}

export interface AttachSessionResult {
  shellId: ShellId;
  /**
   * True when the pool already held a live client for this session, so the
   * renderer is being handed back the PTY it is already bound to and must NOT
   * reset its terminal — the screen it is showing is still the right screen.
   *
   * False when a new PTY was opened: rebind the streams, reset the terminal,
   * adopt the new id.
   *
   * In the per-tab design this is true only for a REPEAT ask about a tab that
   * is already live — a remount behind a `v-show`, a second window on the same
   * workspace, a retry after a transient error. The common case, a user
   * clicking between tabs, never reaches this class at all, because each tab
   * keeps the shell it was given.
   */
  switched: boolean;
}

/**
 * How many tmux clients one connection may hold at once.
 *
 * Six, against an `sshd` `MaxSessions` of 10. The four channels of headroom are
 * not slack: `SshService.exec` opens a channel per call and the app execs
 * constantly (the session list refresh, every projects command, every rename),
 * SFTP holds one for the Files tabs, and `tail` holds one per follow. Sizing
 * this at 9 would make an ordinary folder with nine sessions break file
 * browsing, and the failure — `Channel open failure` on an unrelated feature —
 * would point nowhere near the cause.
 *
 * Six is also comfortably above what a folder holds: docs/WORKSPACE.md §1
 * measured 11 folders holding 11 sessions on this user's host, and the busiest
 * folder in the log has three.
 */
export const MAX_LIVE_CLIENTS = 6;

/** What the pool remembers about one live tmux client. */
interface SessionClient {
  shellId: ShellId;
  /** The session this client is attached to. Fixed for its whole life. */
  session: string;
  /** tmux global-environment variable holding this client's tty. */
  ttyVar: string;
  /**
   * Eviction order: a monotonic counter, NOT a timestamp.
   *
   * `Date.now()` has millisecond resolution and a user clicking through tabs
   * produces several attaches inside one millisecond, which makes every
   * `lastUsed` equal and collapses "least recently used" into "first in the
   * map" — i.e. it would evict the tab the user is actively working in. A
   * counter cannot tie.
   */
  useOrder: number;
  /** When it was last used, for the eviction log only. */
  lastUsedAt: number;
}

export class TmuxClientPool {
  /** connectionId -> sessionName -> its live client. */
  private readonly clients = new Map<string, Map<string, SessionClient>>();
  /**
   * connectionId -> sessionName -> its stable handshake token.
   *
   * Kept even for sessions whose client has been evicted, so a re-join reuses
   * the same tmux variable instead of leaving another behind (see the class
   * comment). Tokens are strings; the map is bounded by sessions visited.
   */
  private readonly tokens = new Map<string, Map<string, string>>();
  /** Ever-increasing stamp handed to a client each time it is used. */
  private useClock = 0;

  constructor(private readonly ssh: SshService) {}

  /**
   * Display [sessionName] on [connectionId].
   *
   * Returns the live client for that session when there is one — which is the
   * whole point, and costs nothing — and otherwise joins, evicting the least
   * recently used client first if the connection is at its channel budget.
   *
   * Never throws for anything the host does; only a failure to open a PTY at
   * all propagates, which is the contract `shell:open` already has.
   */
  async attach(
    connectionId: string,
    sessionName: string,
    opts: AttachSessionOptions,
  ): Promise<AttachSessionResult> {
    const held = this.live(connectionId, sessionName);
    log('tmux', 'attach requested', {
      connectionId,
      sessionName,
      held: held != null,
      liveClients: this.liveCount(connectionId),
    });
    if (held) {
      // The tab is already up. This is the case the whole design exists to
      // make free, and it is free: no exec, no redraw, no bytes on the wire.
      held.useOrder = ++this.useClock;
      held.lastUsedAt = Date.now();
      return { shellId: held.shellId, switched: true };
    }

    this.evictDownTo(connectionId, MAX_LIVE_CLIENTS - 1);
    return this.join(connectionId, sessionName, opts);
  }

  /** Forget a connection's clients. Called when the connection goes away. */
  release(connectionId: string): void {
    this.clients.delete(connectionId);
    this.tokens.delete(connectionId);
  }

  /**
   * A session this pool holds a client for has been renamed on the host.
   *
   * The pool keys clients by NAME, and that name is what {@link isShowing}
   * fences composer sends against and what {@link attach} matches on. A rename
   * behind its back would break two things quietly: the next composer send
   * would be rejected as belonging to a stranger, and re-selecting the renamed
   * session would look like a session we do not hold and cost a full re-join
   * beside the client that is already showing it.
   *
   * Nothing else has to move. The tmux CLIENT is unaffected — clients follow a
   * session by id, so a rename does not detach anything — and the handshake
   * variable is keyed on a random token rather than on the session name. The
   * token map moves with it so a later re-join of the renamed session still
   * overwrites its own tmux variable rather than adding one.
   *
   * Returns true when a record was actually updated, which is only a
   * diagnostic: a rename of a session this connection does not hold is a
   * perfectly ordinary no-op.
   */
  renamed(connectionId: string, from: string, to: string): boolean {
    const held = this.clients.get(connectionId)?.get(from);
    if (!held) return false;
    const byName = this.clients.get(connectionId)!;
    byName.delete(from);
    held.session = to;
    byName.set(to, held);

    const tokens = this.tokens.get(connectionId);
    const token = tokens?.get(from);
    if (tokens && token !== undefined) {
      tokens.delete(from);
      tokens.set(to, token);
    }
    log('tmux', 'session renamed under a live client', { connectionId, from, to });
    return true;
  }

  /**
   * The session a shell is attached to, or null. Test/diagnostic.
   *
   * Keyed on the SHELL rather than on the connection, because a connection no
   * longer has one answer: it has one per live tab.
   */
  sessionForShell(shellId: ShellId): string | null {
    for (const byName of this.clients.values()) {
      for (const held of byName.values()) {
        if (held.shellId === shellId) return held.session;
      }
    }
    return null;
  }

  /** The sessions a connection currently holds live clients for. Diagnostic. */
  liveSessions(connectionId: string): string[] {
    const byName = this.clients.get(connectionId);
    if (!byName) return [];
    return [...byName.values()]
      .filter((held) => this.ssh.shellTracker.get(held.shellId))
      .map((held) => held.session);
  }

  /**
   * Whether it is safe to write [sessionName]'s input to [shellId].
   *
   * With one client per session this fence is exact rather than temporal, and
   * that is a genuine simplification of the hazard commit 516b488 described. A
   * composer send is not one write — it puts the prompt text in, waits (250 ms
   * or more for Codex's TUI), then sends Enter — and under a SHARED client a
   * user who hit Send and immediately clicked another tab could have the Enter
   * submit a stranger's pane, because the shell's meaning changed underneath
   * the send. A per-tab client cannot change meaning: the shell is bound to its
   * session for its whole life, so a send that started against the right shell
   * finishes against the right session no matter what the user clicks.
   *
   * The check is kept anyway, and is now a real assertion rather than a race
   * guard: it catches a caller holding a stale id for a session whose tab was
   * evicted and re-joined onto a different shell. A caller that names no
   * session is passed through, as before — terminal keystrokes come from the
   * focused pane and always mean whatever it is currently displaying, and a
   * shell this pool never opened cannot be misrouted in the first place.
   */
  isShowing(shellId: ShellId, sessionName: string): boolean {
    const session = this.sessionForShell(shellId);
    if (session === null) return true;
    return session === sessionName;
  }

  /**
   * The remembered client for a session, but only if its channel is still
   * tracked.
   *
   * The renderer closes the PTY when a terminal unmounts, and a dropped
   * connection closes every shell on it, neither of which routes through this
   * class. Consulting the tracker rather than trusting the map is what keeps a
   * closed channel from being handed out as a live client.
   */
  private live(connectionId: string, sessionName: string): SessionClient | undefined {
    const byName = this.clients.get(connectionId);
    const held = byName?.get(sessionName);
    if (!held) return undefined;
    if (this.ssh.shellTracker.get(held.shellId)) return held;
    byName!.delete(sessionName);
    return undefined;
  }

  /** How many of a connection's remembered clients still have a live channel. */
  private liveCount(connectionId: string): number {
    const byName = this.clients.get(connectionId);
    if (!byName) return 0;
    let n = 0;
    for (const [name, held] of [...byName]) {
      // Prune as we count: a shell the renderer or a drop closed is not a
      // client, and leaving it in the map would evict a healthy tab to make
      // room that was already there.
      if (this.ssh.shellTracker.get(held.shellId)) n += 1;
      else byName.delete(name);
    }
    return n;
  }

  /**
   * Close least-recently-used clients until at most [limit] remain live.
   *
   * LRU rather than oldest-first because the tabs a user moves between are the
   * ones that must stay instant, and those are exactly the recently used ones.
   * Closing the PTY is the whole of an eviction: the tmux session is
   * server-side and survives untouched, so the tab loses its channel and
   * nothing else, and the renderer finds out through the `shell:exited` it
   * already listens for.
   */
  private evictDownTo(connectionId: string, limit: number): void {
    const byName = this.clients.get(connectionId);
    if (!byName) return;
    while (this.liveCount(connectionId) > Math.max(0, limit)) {
      let victim: SessionClient | undefined;
      for (const held of byName.values()) {
        if (!this.ssh.shellTracker.get(held.shellId)) continue;
        if (!victim || held.useOrder < victim.useOrder) victim = held;
      }
      if (!victim) return;
      log('tmux', 'evicting the least recently used client to stay under the channel budget', {
        connectionId,
        session: victim.session,
        shellId: victim.shellId,
        idleMs: Date.now() - victim.lastUsedAt,
        budget: MAX_LIVE_CLIENTS,
      });
      this.ssh.shellClose(victim.shellId);
      byName.delete(victim.session);
    }
  }

  /**
   * Open a PTY and run the documented join in it.
   *
   * There is no longer a `note` parameter. It existed to print, into the
   * terminal, the tmux reason a failed `switch-client` had forced a re-join —
   * a fallback nobody could see. The pool no longer switches, so there is no
   * such fallback and nothing to explain: a join here is either the first time
   * a tab was opened or the return to an evicted one, and both are ordinary.
   */
  private async join(
    connectionId: string,
    sessionName: string,
    opts: AttachSessionOptions,
  ): Promise<AttachSessionResult> {
    const ttyVar = clientTtyVar(this.tokenFor(connectionId, sessionName));
    // The callbacks need the id of the shell they belong to, and the id only
    // exists once `openTrackedShell` resolves. A `const` captured from the
    // enclosing scope would be in its temporal dead zone for any byte that
    // arrives before that — so the id is handed over through a mutable box the
    // callbacks read at call time instead. The null guards below never fire in
    // practice: `openTrackedShell` binds its channel listeners synchronously
    // and resolves, and the microtask that assigns `id` runs before the event
    // loop can deliver the next I/O callback. They are there so the types say
    // so rather than so bytes get dropped.
    let id: ShellId | null = null;
    const shellId = await this.ssh.openTrackedShell(connectionId, {
      command: sessionAttachCommand(sessionName, ttyVar),
      cols: opts.cols,
      rows: opts.rows,
      onData: (data) => {
        if (id) opts.onData(id, data);
      },
      onExit: (exitCode) => {
        if (!id) return;
        // The PTY died — the user typed `exit`, the session was killed, the
        // channel dropped, or this pool evicted it. Drop the record so the
        // next attach joins rather than handing back a dead client.
        const byName = this.clients.get(connectionId);
        if (byName?.get(sessionName)?.shellId === id) byName.delete(sessionName);
        opts.onExit(id, exitCode);
      },
    });
    id = shellId;
    let byName = this.clients.get(connectionId);
    if (!byName) {
      byName = new Map();
      this.clients.set(connectionId, byName);
    }
    byName.set(sessionName, {
      shellId,
      session: sessionName,
      ttyVar,
      useOrder: ++this.useClock,
      lastUsedAt: Date.now(),
    });
    return { shellId, switched: false };
  }

  /**
   * The handshake token for one (connection, session).
   *
   * Per session rather than per connection, because there is now a client per
   * session and they must not share a tmux variable — the second join would
   * overwrite the first's tty and a reader could not tell the two clients
   * apart. Stable across re-joins of the same session, so an evicted tab that
   * is revisited overwrites its own entry rather than leaving another behind.
   */
  private tokenFor(connectionId: string, sessionName: string): string {
    let byName = this.tokens.get(connectionId);
    if (!byName) {
      byName = new Map();
      this.tokens.set(connectionId, byName);
    }
    let token = byName.get(sessionName);
    if (!token) {
      token = randomBytes(6).toString('hex');
      byName.set(sessionName, token);
    }
    return token;
  }
}
