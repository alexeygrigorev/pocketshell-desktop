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
 * ## Why the fallback, and why it is a runtime test rather than a build-time one
 *
 * `bootstrap.ts` probes for `pocketshell` and `tmux` — not `tmuxctl`, which
 * ships alongside `pocketshell` rather than being checked for in its own
 * right. A host with an older helper may not have it at all: 0.4.44 is where
 * the hints were renamed from `pocketshell sessions <id>` to `tmuxctl <id>`,
 * and the docs describe a v0.4.8 contract that real hosts have long since left
 * behind. Rather than pick one and be wrong on half the fleet, this asks the
 * host at attach time, which costs one `command -v` in a shell that is being
 * started anyway.
 *
 * The chain degrades in the order the helper renamed things: `tmuxctl`, then
 * the older `pocketshell sessions`, then raw tmux — which remains correct for
 * a host whose sessions really are on the default tmux socket.
 *
 * Deliberately no `exec`: the command is run inside the session's login shell,
 * and without `exec` a detach or a failed join drops the user back at a live
 * prompt instead of closing the PTY out from under them.
 */

/** Wrap a value for POSIX single quotes, escaping any embedded quote. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the join command for [sessionName].
 *
 * The name is quoted once and reused, so a session called `it's mine` — which
 * tmux permits and {@link sanitisePart} never produces but a foreign session
 * can carry — cannot break out of the quoting in any branch.
 */
export function sessionAttachCommand(sessionName: string): string {
  const name = shellSingleQuote(sessionName);
  return (
    `if command -v tmuxctl >/dev/null 2>&1; then tmuxctl ${name}; ` +
    `elif command -v pocketshell >/dev/null 2>&1; then pocketshell sessions ${name}; ` +
    `else tmux attach -t ${name}; fi`
  );
}
