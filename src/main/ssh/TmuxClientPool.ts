import { randomBytes } from 'node:crypto';
import type { ShellId } from '../../shared/types.js';
import {
  clientTtyVar,
  sessionAttachCommand,
  sessionSwitchCommand,
  SWITCH_CLIENT_NOT_READY_EXIT,
  SWITCH_NO_CLIENT_EXIT,
} from '../../shared/attachCommand.js';
import type { SshService } from './SshService.js';
import { log } from '../log.js';

/**
 * One attached tmux client per SSH connection, moved between sessions with
 * `tmux switch-client` instead of being torn down and rebuilt.
 *
 * ## The problem
 *
 * Selecting a session used to mean: open a second SSH channel, request a PTY,
 * wait for a login shell, and run `tmuxctl <name>` in it. Every part of that
 * is per-switch cost, and none of it is work the user asked for — they asked
 * to look at a different session on a host they are already attached to.
 * Measured against the Docker fixture that is ~250 ms of host time before the
 * first byte of the new session is drawn, ~220 ms of it Python startup inside
 * tmuxctl. See the cost table in src/shared/attachCommand.ts.
 *
 * tmux already has the operation the user is describing. A client attached to
 * a server can be pointed at any other session on that server without
 * detaching, and tmuxctl itself does exactly that when it is run from inside
 * tmux. This class holds on to the client so that operation is available.
 *
 * ## The shape
 *
 * The first session opened on a connection is a normal join — the same
 * `tmuxctl` command, in the same kind of PTY, with the same failure text. All
 * that is added is a handshake statement recording the PTY's tty. Every
 * SUBSEQUENT session on that connection is one exec channel carrying one
 * `switch-client`, and the renderer keeps the same {@link ShellId}: same
 * channel, same xterm, same everything, new contents.
 *
 * ## Why every failure degrades to a full join — and why it no longer does so
 * ## silently
 *
 * A switch can fail because the user detached the client from inside tmux,
 * because the session was killed on the host, because the handshake found no
 * tty, or because the link is sick — and the right RECOVERY for all four is the
 * same: close whatever we were holding and join from scratch, which is
 * precisely what the app did before this class existed. That makes the worst
 * case of the fast path equal to the old behaviour plus one cheap exec.
 *
 * This class used to draw the further conclusion that the four therefore did
 * not need telling apart, and that a host the optimisation did not suit should
 * degrade silently. Both halves of that were wrong, and together they hid the
 * defect that made the feature inert for every user: `switch-client` was being
 * asked for a client that the join had not finished creating, roughly two
 * seconds before it existed. Every signal said the fast path was available,
 * every switch failed, every failure became a re-join that opened a fresh
 * two-second window, and the only symptom was that nothing got faster.
 *
 * So the recovery is unchanged and the reporting is not. The switch waits for
 * its own client instead of concluding it has none; the exit codes distinguish
 * "no rendezvous" from "no client yet" from tmux refusing; and a re-join that a
 * failed switch forced prints tmux's reason into the terminal the user is
 * already looking at, because a fallback nobody can see is a fallback nobody
 * can report.
 *
 * ## What it costs
 *
 * One tmux global-environment variable per connection, left behind on the
 * host's tmux server when the app goes away. It cannot be unset from here —
 * by the time a connection closes there is no channel left to unset it on —
 * and the token is stable for a connection's lifetime specifically so a
 * re-join overwrites its own entry rather than adding another. Two app windows
 * on one host get one entry each, which is the reason the token is random at
 * all: a fixed name would have the second window's join silently redirect the
 * first window's switches.
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
   * True when an existing client was pointed at the session, so the renderer
   * still owns the same PTY and must NOT reset its terminal — tmux redraws the
   * whole client itself, and a reset would drop the DEC private modes (mouse
   * reporting above all) that the still-attached tmux client set and expects.
   *
   * False when a new PTY was opened, which is the case the renderer has always
   * handled: rebind the streams, reset the terminal, adopt the new id.
   */
  switched: boolean;
}

/**
 * How long after a join a tmux client may still be on its way up.
 *
 * A join is a login shell plus `tmuxctl`, and tmuxctl is Python: measured, the
 * tmux client appears ~330 ms after the join on a loopback Docker fixture and
 * 1.5-2 s on a real host over a real link. Until it does, `switch-client -c`
 * fails with `can't find client` even though every other signal says the fast
 * path is available — which is exactly how this feature came to be inert (see
 * {@link sessionSwitchCommand}).
 *
 * The budget is generous because being wrong in the two directions costs very
 * different amounts. Too short and the switch degrades to a full re-join, which
 * restarts the same window and keeps the app permanently slow. Too long and a
 * client that is genuinely gone delays ONE re-join, once, by the remainder —
 * and only when the join it belongs to failed, because a client that comes up
 * ends the wait the moment it does.
 */
const CLIENT_SETTLE_MS = 5_000;

/** What the pool remembers about one connection's attached client. */
interface SharedClient {
  shellId: ShellId;
  /** tmux global-environment variable holding this client's tty. */
  ttyVar: string;
  /** The session the client is currently displaying. */
  session: string;
  /** When the PTY was opened, for sizing the settle budget above. */
  joinedAt: number;
  /**
   * True once a switch has actually moved this client, which proves tmux has
   * it. From then on there is nothing to wait for: a switch that cannot find
   * it is a client that has GONE (the user detached from inside tmux), not one
   * that has yet to arrive, and waiting for it would only delay the re-join.
   */
  proven: boolean;
}

/**
 * One short line saying why a switch could not be taken, for the log AND for
 * the terminal.
 *
 * tmux's own words are preferred wherever it supplied any — `can't find
 * session: foo` is more useful than anything this file could paraphrase, and it
 * is the string a user can search for. Only the two codes the script raises
 * itself get written out here, because tmux never says them.
 */
export function switchFailureReason(exitCode: number, stderr: string): string {
  const first = stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (exitCode === SWITCH_NO_CLIENT_EXIT) {
    return 'this host published no tmux client for the app to reuse';
  }
  if (exitCode === SWITCH_CLIENT_NOT_READY_EXIT) {
    return 'the tmux client for the previous session never came up';
  }
  return first ?? `tmux switch-client exited ${exitCode}`;
}

export class TmuxClientPool {
  private readonly clients = new Map<string, SharedClient>();
  /** connectionId -> its stable handshake token (see the class comment). */
  private readonly tokens = new Map<string, string>();

  constructor(private readonly ssh: SshService) {}

  /**
   * Display [sessionName] on [connectionId], reusing the attached client when
   * there is one. Never throws for a switch that did not work; only a failure
   * to open a PTY at all propagates, which is the same contract
   * `shell:open` already has.
   */
  async attach(
    connectionId: string,
    sessionName: string,
    opts: AttachSessionOptions,
  ): Promise<AttachSessionResult> {
    // Every branch below is logged. This whole path is designed to degrade
    // silently — a switch that does not work becomes an ordinary re-join,
    // which is correct but indistinguishable from the feature never having
    // shipped. The log is the only way to tell which branch actually ran.
    const held = this.live(connectionId);
    log('tmux', 'attach requested', {
      connectionId,
      sessionName,
      hasClient: held != null,
      showing: held?.session ?? null,
    });
    if (held) {
      // Already showing it. Re-attaching or re-switching would only cost a
      // redraw; this happens when the renderer re-asks for the session it is
      // on (a remount behind a v-show, a retry after a transient error).
      if (held.session === sessionName) return { shellId: held.shellId, switched: true };

      // How long the switch may wait for its client before giving up. A client
      // that has already been switched once is known to exist, so there is
      // nothing to wait for; a fresh join may still be starting Python.
      const waitMs = held.proven
        ? 0
        : Math.max(0, CLIENT_SETTLE_MS - (Date.now() - held.joinedAt));
      const started = Date.now();
      const res = await this.ssh.exec(
        connectionId,
        sessionSwitchCommand(held.ttyVar, sessionName, waitMs),
      );
      if (res.exitCode === 0) {
        held.session = sessionName;
        held.proven = true;
        log('tmux', 'switch-client ok', { sessionName, waitMs, ms: Date.now() - started });
        return { shellId: held.shellId, switched: true };
      }

      // The fallback the user cannot see — from here it is made visible, in the
      // terminal, by handing the reason to the re-join below.
      //
      // The three interesting exits are different diagnoses. 65: the handshake
      // variable was not there at all, so the PTY's `tmux` and this exec's
      // `tmux` are probably not the same server — a host-compatibility problem
      // this optimisation cannot solve. 66: the variable was there and named a
      // tty that never became a client within the budget, so the join it
      // belonged to failed. Anything else is tmux itself refusing, and its
      // stderr says which: `can't find session` proves the client WAS found
      // (tmux resolves -c before -t), so the handshake worked and the session
      // is the problem.
      const reason = switchFailureReason(res.exitCode, res.stderr);
      log('tmux', 'switch-client FAILED - falling back to full re-join', {
        sessionName,
        ttyVar: held.ttyVar,
        exitCode: res.exitCode,
        noHandshake: res.exitCode === SWITCH_NO_CLIENT_EXIT,
        clientNotReady: res.exitCode === SWITCH_CLIENT_NOT_READY_EXIT,
        waitMs,
        reason,
        stderr: res.stderr.trim().slice(0, 400),
        stdout: res.stdout.trim().slice(0, 400),
        ms: Date.now() - started,
      });

      // Any non-zero exit: give up on this client entirely and join afresh.
      // Closing it here rather than leaving it to the renderer keeps the old
      // ordering intact — one PTY attached to this connection at a time — even
      // though the renderer no longer closes anything on a session change.
      this.ssh.shellClose(held.shellId);
      this.clients.delete(connectionId);
      return this.join(
        connectionId,
        sessionName,
        opts,
        `fast session switch unavailable (${reason}) - re-joining instead`,
      );
    }

    return this.join(connectionId, sessionName, opts);
  }

  /** Forget a connection's client. Called when the connection goes away. */
  release(connectionId: string): void {
    this.clients.delete(connectionId);
    this.tokens.delete(connectionId);
  }

  /** The session a connection's client is showing, or null. Test/diagnostic. */
  currentSession(connectionId: string): string | null {
    return this.live(connectionId)?.session ?? null;
  }

  /**
   * Whether it is safe to write [sessionName]'s input to [shellId].
   *
   * This is the one hazard a shared client introduces, and it is worth naming
   * precisely. A composer send is not one write: it puts the prompt text in,
   * waits (250 ms or more for Codex's TUI), then sends Enter. When each session
   * had its own PTY, a session change mid-send was harmless — the leftover
   * writes went to a channel nobody was looking at. With one client they go to
   * whatever session it is showing NOW, so a user who hits Send and
   * immediately clicks another session could have the Enter submit a stranger's
   * pane.
   *
   * A caller that names the session it means gets fenced against that. A caller
   * that does not is passed through: terminal keystrokes come from the focused
   * pane and are always meant for whatever it is currently displaying, and a
   * shell this pool never opened cannot be misrouted in the first place.
   */
  isShowing(shellId: ShellId, sessionName: string): boolean {
    for (const held of this.clients.values()) {
      if (held.shellId === shellId) return held.session === sessionName;
    }
    return true;
  }

  /**
   * The remembered client, but only if its channel is still tracked.
   *
   * The renderer closes the PTY when the terminal unmounts, and a dropped
   * connection closes every shell on it, neither of which routes through this
   * class. Consulting the tracker rather than trusting the map is what keeps a
   * closed channel from being handed out as a live client.
   */
  private live(connectionId: string): SharedClient | undefined {
    const held = this.clients.get(connectionId);
    if (!held) return undefined;
    if (this.ssh.shellTracker.get(held.shellId)) return held;
    this.clients.delete(connectionId);
    return undefined;
  }

  /**
   * Open a PTY and run the documented join in it.
   *
   * [note], when present, is printed into that PTY before the join runs. It is
   * only ever set for a re-join that a failed switch forced, and it exists
   * because "make the fallback visible" cannot mean "write a log line": the
   * symptom the user reports is a session taking a second to open, and the
   * place they are looking when it happens is the terminal. One line there,
   * naming tmux's own reason, turns a silent slow path into an explained one.
   *
   * It is printed BEFORE `tmuxctl` because that is the only moment it can be:
   * once tmux attaches it owns the screen. tmux draws over the alternate
   * screen, so the note survives in the normal buffer rather than being lost.
   */
  private async join(
    connectionId: string,
    sessionName: string,
    opts: AttachSessionOptions,
    note?: string,
  ): Promise<AttachSessionResult> {
    const ttyVar = clientTtyVar(this.tokenFor(connectionId));
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
      command: sessionAttachCommand(sessionName, ttyVar, note),
      cols: opts.cols,
      rows: opts.rows,
      onData: (data) => {
        if (id) opts.onData(id, data);
      },
      onExit: (exitCode) => {
        if (!id) return;
        // The PTY died — the user typed `exit`, the session was killed, the
        // channel dropped. Drop the record so the next attach joins rather
        // than switching a client that is not there.
        if (this.clients.get(connectionId)?.shellId === id) {
          this.clients.delete(connectionId);
        }
        opts.onExit(id, exitCode);
      },
    });
    id = shellId;
    this.clients.set(connectionId, {
      shellId,
      ttyVar,
      session: sessionName,
      joinedAt: Date.now(),
      proven: false,
    });
    return { shellId, switched: false };
  }

  private tokenFor(connectionId: string): string {
    let token = this.tokens.get(connectionId);
    if (!token) {
      token = randomBytes(6).toString('hex');
      this.tokens.set(connectionId, token);
    }
    return token;
  }
}
