/**
 * The user-bin directories the helper is allowed to live in.
 *
 * This exists as one constant because it is consumed from both sides of the
 * process boundary and the two uses have to agree:
 *
 *   - `src/main/helper/bootstrap.ts` prepends it before `command -v` when it
 *     probes a host over an SSH *exec* channel, which sshd runs under a
 *     non-login shell whose PATH is often just `/usr/bin:/bin`;
 *   - `src/shared/attachCommand.ts` prepends it inside the session PTY before
 *     invoking the helper.
 *
 * If those two lists ever drift, bootstrap reports a helper the attach command
 * then cannot find — the app says the host is fine and the join fails anyway,
 * which is the exact shape of the bug this whole module exists to prevent.
 *
 * The list matches the Android app's `pathAwareCommand` wrapper.
 */
export const USER_BIN_DIRS = ['$HOME/.local/bin', '$HOME/bin', '$HOME/.cargo/bin'] as const;

/**
 * The user-bin dirs as a PATH prefix, joined with `:` — no trailing `:$PATH`,
 * because the two call sites splice it into different shapes.
 */
export const USER_BIN_PATH = USER_BIN_DIRS.join(':');
