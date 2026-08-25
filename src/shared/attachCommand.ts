/**
 * The command that joins an existing session inside the session PTY.
 *
 * ## Why this is not `tmux attach -t <name>`
 *
 * It used to be, and it did not work. Sessions are CREATED through the helper
 * (`sessions create` -> `tmuxctl create-detached`) and LISTED through the
 * helper (`pocketshell sessions list`), but attaching went straight to raw
 * tmux — so the one operation in the trio that bypassed the helper was the one
 * that failed, with `can't find session: <name>` for every session in a list
 * the app had just rendered from that same host.
 *
 * That failure was originally written up here as "the helper does not keep its
 * sessions on the default tmux socket". That explanation is WRONG, and it is
 * corrected rather than deleted because the rest of this file was reasoned
 * from it. tmuxctl 0.4.x shells out to a bare `tmux` with no `-L`/`-S` and no
 * TMUX_TMPDIR of its own (`tmuxctl/tmux_api.py::_run_tmux`), and a session it
 * created reports `#{socket_path}` = `/tmp/tmux-<uid>/default`. There is one
 * socket, and it is the default one. Whatever broke the raw attach on that
 * host — most likely `tmux` resolving differently, or the name having been
 * normalised by tmuxctl's `_resolve_session_name` — it was not the socket.
 *
 * The conclusion below is unchanged: `tmuxctl <name>` stays the ONE join. It
 * resolves ids and normalised names, it checks the session exists before
 * attaching, and it is what the helper documents. Because the socket is shared,
 * a raw `tmux` command CAN address the same server, which is how
 * {@link publishClientTty} reaches the tmux tmuxctl is about to attach to.
 *
 * ## What a raw attach would save, and why it is still not taken
 *
 * `tmuxctl` is Python, and starting the interpreter with typer and rich is
 * almost the whole of the join. Measured against the fixture, PTY + login shell
 * + `tmuxctl <name>` is p50 154 ms (max 284); the same PTY running
 * `tmux attach-session -t '=<name>'` instead is p50 12 ms. On the user's host
 * the gap is far wider — their joins run 1.5-2 s.
 *
 * That 12x is real and it is now the largest cost left in opening a session,
 * because the pool opens one client per tab and holds it (see TmuxClientPool),
 * so a join happens once per tab rather than once per switch. It is still not
 * taken here, for the reason the removed fallback ladder was removed: raw
 * `tmux attach` is the command that was observed failing on a real host, and a
 * join that degrades into it turns "the helper is missing" into "can't find
 * session", which reads as a stale session list rather than a broken install.
 * Changing the join is a separate decision from changing how many joins there
 * are, and only the second one had to be made to stop tab switching being slow.
 *
 * The helper's own output says what the join command is. The footer of
 * `pocketshell sessions list` on 0.4.44 (captured verbatim in
 * tests/unit/fixtures/v0.4.44-sessions-list.txt) reads:
 *
 *     Join a session: tmuxctl <id> or tmuxctl <session>
 *     Create a new one: tmuxctl :<session>
 *
 * A bare name joins; the `:` prefix is what creates. So a plain
 * `tmuxctl <session>` is the documented join, and it cannot silently create a
 * session that was not there.
 *
 * ## Why there is no fallback ladder
 *
 * The first attempt at this fix was a three-branch chain — `tmuxctl`, else the
 * older `pocketshell sessions <name>` spelling, else raw `tmux attach`. Both
 * fallbacks are removed, for different reasons.
 *
 * `pocketshell sessions <name>` is the pre-0.4.44 spelling of the same
 * operation, kept only for hosts running an older helper. Real hosts run
 * 0.4.44; the v0.4.8 contract in the docs is stale. Per docs/ANALYSIS.md D22
 * this app takes hard cuts rather than carrying legacy shims, so the old
 * spelling goes.
 *
 * The raw-tmux branch is worse than merely redundant: it is the command that
 * was already observed failing on a real host, and a chain that degrades into
 * it turns "the helper is missing" into "can't find session", which reads as a
 * stale session list rather than a broken install. A fallback whose failure
 * mode impersonates a different bug is not a fallback.
 *
 * So there is one join path, and when it cannot be taken the terminal says so.
 *
 * ## Why the PATH is widened first
 *
 * `command -v tmuxctl` can come up empty on a host where tmuxctl is installed,
 * because the helper installs into `~/.local/bin` and the PTY's shell does not
 * always have it. Rather than probe and guess, the join prepends exactly the
 * directories {@link USER_BIN_DIRS} that `bootstrap.ts` prepends when it
 * decides whether the helper is installed at all — so the shell that joins
 * searches the same places as the probe that said the host was ready.
 *
 * The assignment sits inside a subshell so it lasts exactly as long as the
 * join. The user is left at their own login shell afterwards, with the PATH
 * their dotfiles gave them, not one this app edited behind their back.
 *
 * ## Why a failed join shouts
 *
 * The PTY runs an interactive login shell and this command is written to its
 * stdin, so a failure leaves the user looking at a prompt — which is
 * indistinguishable from the app having done nothing at all. That ambiguity is
 * how the original bug survived: clicking a session looked like a no-op. The
 * `||` arm turns any non-zero exit — helper missing, session genuinely gone,
 * helper erroring — into a labelled line naming the session that failed.
 *
 * Deliberately no `exec`: the command is run inside the session's login shell,
 * and without `exec` a detach or a failed join drops the user back at a live
 * prompt instead of closing the PTY out from under them — which is also what
 * makes the diagnostic above readable rather than a flash before teardown.
 */

import { USER_BIN_PATH } from './userBinPath';

/** Wrap a value for POSIX single quotes, escaping any embedded quote. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the join command for [sessionName].
 *
 * The name is quoted once and reused, so a session called `it's mine` — which
 * tmux permits and {@link sanitisePart} never produces but a foreign session
 * can carry — cannot break out of the quoting, in the join or in the
 * diagnostic. The diagnostic passes the name as a printf *argument* rather
 * than splicing it into the format string, so a name containing a `%` cannot
 * turn into a conversion specifier.
 */
export function sessionAttachCommand(sessionName: string, ttyVar?: string): string {
  const name = shellSingleQuote(sessionName);
  const failure =
    '\\n[PocketShell] could not join session %s. ' +
    'The helper (tmuxctl) is how sessions are joined - check it is installed on this host.\\n';
  const handshake = ttyVar ? `${publishClientTty(ttyVar)}; ` : '';
  return `( PATH="${USER_BIN_PATH}:$PATH"; ${handshake}tmuxctl ${name} ) || printf '${failure}' ${name}`;
}

// ---------------------------------------------------------------------------
// Telling OUR tmux client apart from the user's own
// ---------------------------------------------------------------------------
/**
 * ## Why a joined PTY announces its tty
 *
 * A host's tmux server will happily have several clients attached at once, and
 * `list-clients` lists them all: the tabs this app is holding, the user's own
 * terminal, their phone. Nothing in tmux's own output says which is which, so
 * the joining PTY writes its `$(tty)` into the tmux server's global environment
 * under a name only this app knows.
 *
 * That rendezvous also proves the two halves of a join reached the SAME tmux
 * server. The write happens in the session PTY's login shell; anything reading
 * it back does so from a separate, non-login exec channel, so a host where
 * those resolve `tmux` differently simply finds nothing rather than acting on
 * the wrong server.
 *
 * ## What used to read it back, and why nothing does now
 *
 * This variable was built for `tmux switch-client -c <tty>`: one attached
 * client per connection, moved between sessions instead of being rebuilt, which
 * turned a ~250 ms re-join into a ~10 ms exec on a loopback fixture. Measured
 * on a real host it did not hold up — a switch that worked cost p50 210 ms
 * because an exec channel is round trips and a repaint is 10.7 KB, and most
 * switches did not work at all. The pool now keeps a client per session tab and
 * never moves one, so switching tabs costs nothing and there is no switch
 * command left to read this. See the header of TmuxClientPool for the numbers.
 *
 * The handshake is kept because the diagnostic value was always separate from
 * the optimisation: it is still the only way a bug report about a stray tmux
 * client can say whether the client was ours.
 */

/**
 * The tmux global-environment variable a joined PTY publishes its tty under.
 *
 * Non-identifier characters are stripped rather than escaped: this name is
 * spliced into shell text where quoting cannot save a name that is not an
 * identifier in the first place. The caller supplies a random token, so
 * stripping never collides in practice.
 */
export function clientTtyVar(token: string): string {
  return `PS_DESKTOP_TTY_${token.replace(/[^A-Za-z0-9_]/g, '')}`;
}

/**
 * The statement the join command runs before `tmuxctl` to record its own tty.
 *
 * `2>/dev/null` and a `;` rather than `&&`: this is a diagnostic's setup, not
 * part of the join. A host where it fails (no server yet, a tmux too old for
 * `set-environment`, tmux not on PATH) must still join normally, and the only
 * cost of the failure is that `list-clients` cannot be read back with
 * certainty.
 */
function publishClientTty(ttyVar: string): string {
  return `tmux set-environment -g ${ttyVar} "$(tty)" 2>/dev/null`;
}
