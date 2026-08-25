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
 * attaching, and it is what the helper documents. But because the socket is
 * shared, a raw `tmux` command CAN address the same server — which is what
 * {@link sessionSwitchCommand} relies on to make a session switch cost one
 * exec instead of a whole new login shell.
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
// Switching an ALREADY-ATTACHED client to another session
// ---------------------------------------------------------------------------
/**
 * ## Why a switch exists at all
 *
 * Joining is expensive and almost all of the expense is fixed cost that has
 * nothing to do with the session being joined. Measured against the Docker
 * fixture (tests-docker/Dockerfile.helper, tmux 3.4, tmuxctl 0.4.x) over a
 * loopback SSH link, so these are essentially pure host-side costs with no
 * network in them:
 *
 *     open a PTY channel + login shell + `echo`      ~16 ms
 *     ... + `tmuxctl <name>`   (python, typer, rich)  ~250 ms
 *     ... + raw `tmux attach-session -t <name>` (C)   ~16 ms
 *     one exec channel + `tmux switch-client`          ~10 ms
 *
 * So a session switch that re-joins pays ~250 ms before a single byte of the
 * new session is drawn, and ~220 ms of that is Python interpreter startup
 * inside tmuxctl. On a real link the gap widens: a re-join also pays for a
 * second SSH channel and a fresh login shell (dotfiles, prompt frameworks,
 * version managers), while a switch pays for one exec and a redraw.
 *
 * ## Why it is safe to speak raw tmux here
 *
 * See the socket correction at the top of this file: there is one tmux server
 * on the default socket, and tmuxctl itself issues `tmux switch-client -t
 * <name>` whenever it is invoked from inside tmux (`tmux_api.attach_session`).
 * This is not a new mechanism, it is the same one, aimed at a client we know
 * the tty of instead of at `$TMUX`.
 *
 * ## Why the tty comes from tmux's own environment
 *
 * `switch-client` needs `-c <client-tty>` to say WHICH client moves, and the
 * app has no other way to know which of a host's tmux clients is the pane it
 * owns — `list-clients` will happily also list the user's own terminal. So the
 * joining PTY publishes its tty into the tmux server's global environment
 * ({@link publishClientTty}) and the switch reads it back out.
 *
 * That rendezvous does double duty. It is a HANDSHAKE: the write happens in
 * the session PTY's login shell and the read happens in a separate,
 * non-login exec channel, so if those two ever resolve `tmux` to different
 * servers the read simply finds nothing and the switch declines
 * ({@link SWITCH_NO_CLIENT_EXIT}) rather than switching some unrelated
 * client. The caller's fallback is a plain re-join, which is what the app did
 * before any of this existed — so the worst case of a mismatched host is
 * today's behaviour, not a broken one.
 */

/**
 * Exit code the switch script uses for "there is no client of ours to switch".
 * Distinct from tmux's own failures only by intent; every non-zero exit tells
 * the caller the same thing (fall back to a full join), and the value is
 * chosen outside the 1-2 range that tmux and sh use so a reader of a trace can
 * tell the two apart.
 */
export const SWITCH_NO_CLIENT_EXIT = 65;

/**
 * The tmux global-environment variable a joined PTY publishes its tty under.
 *
 * Non-identifier characters are stripped rather than escaped: this name is
 * spliced into a shell parameter expansion (`${v#NAME=}`), where quoting
 * cannot save a name that is not an identifier in the first place. The caller
 * supplies a random token, so stripping never collides in practice.
 */
export function clientTtyVar(token: string): string {
  return `PS_DESKTOP_TTY_${token.replace(/[^A-Za-z0-9_]/g, '')}`;
}

/**
 * The statement the join command runs before `tmuxctl` to record its own tty.
 *
 * `2>/dev/null` and a `;` rather than `&&`: this is an optimisation's setup,
 * not part of the join. A host where it fails (no server yet, a tmux too old
 * for `set-environment`, tmux not on PATH) must still join normally, and the
 * only cost of the failure is that switching stays as slow as it is today.
 */
function publishClientTty(ttyVar: string): string {
  return `tmux set-environment -g ${ttyVar} "$(tty)" 2>/dev/null`;
}

/**
 * Move the client recorded under [ttyVar] to [sessionName], as ONE exec.
 *
 * Read the script right to left and it is four statements:
 *
 *   1. read the published tty back out of the tmux server's environment;
 *   2. strip the `NAME=` prefix tmux prints in front of the value;
 *   3. bail with {@link SWITCH_NO_CLIENT_EXIT} unless a value actually came
 *      back — `${v#NAME=}` leaves the string untouched when the prefix is
 *      absent, so comparing against the original is what detects garbage;
 *   4. `exec` the switch, so the exit code the caller sees is tmux's own.
 *
 * Resolving the tty inside the same exec, every time, rather than caching it
 * in the main process, is deliberate. A cache would have to be invalidated
 * when the user detaches the client from inside tmux (prefix-d), and would
 * race with the gap between the join command running and tmux actually
 * attaching. Re-reading costs nothing measurable — it is one more round trip
 * inside a channel that is already open — and it cannot go stale.
 *
 * The target is `=<name>`: tmux's `-t` is otherwise a prefix/fnmatch match, so
 * a session called `api` would happily switch a client to `api-staging`. A
 * name that itself begins with `=` would be looked up without its first
 * character; tmuxctl normalises names to `[A-Za-z0-9_-]`, so no session this
 * app can create is affected.
 *
 * Wrapped in `/bin/sh -lc` for the same reason as `bootstrap.pathAwareCommand`:
 * sshd runs an exec channel under the user's login shell, and the parameter
 * expansion above is POSIX sh, not csh or fish.
 */
export function sessionSwitchCommand(ttyVar: string, sessionName: string): string {
  const target = shellSingleQuote(`=${sessionName}`);
  const script =
    `export PATH="${USER_BIN_PATH}:$PATH"; ` +
    `v=$(tmux show-environment -g ${ttyVar} 2>/dev/null) || exit ${SWITCH_NO_CLIENT_EXIT}; ` +
    `t=\${v#${ttyVar}=}; ` +
    `[ -n "$t" ] && [ "$t" != "$v" ] || exit ${SWITCH_NO_CLIENT_EXIT}; ` +
    `exec tmux switch-client -c "$t" -t ${target}`;
  return `/bin/sh -lc ${shellSingleQuote(script)}`;
}
