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
 * the app had just rendered from that same host. The helper does not keep its
 * sessions on the default tmux socket, so a raw `tmux attach` is looking in a
 * place they were never going to be.
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
export function sessionAttachCommand(sessionName: string): string {
  const name = shellSingleQuote(sessionName);
  const failure =
    '\\n[PocketShell] could not join session %s. ' +
    'The helper (tmuxctl) is how sessions are joined - check it is installed on this host.\\n';
  return `( PATH="${USER_BIN_PATH}:$PATH"; tmuxctl ${name} ) || printf '${failure}' ${name}`;
}
