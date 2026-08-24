/**
 * POSIX single-quote escaping for every value that reaches a remote shell.
 *
 * Ported from the Android gateway's `shellQuoteValue` /
 * `shellQuoteRemotePathValue`
 * (app/src/main/java/com/pocketshell/app/projects/FolderListGateway.kt:2046
 * and :2049). The desktop had the same escape inlined as
 * `.replace(/'/g, "'\\''")` at half a dozen call sites in
 * PocketshellClient/SshService; it now lives here so a new call site cannot
 * quietly forget it.
 *
 * The rule: wrap in single quotes and replace every embedded `'` with
 * `'\''` (close, escaped quote, reopen). Inside single quotes POSIX sh
 * expands nothing — no `$`, no backtick, no `$(...)`, no `;`, no newline —
 * so a folder called `wei'rd $(touch /tmp/PWNED)` is passed through as data.
 */

/** Quote an arbitrary value as a single POSIX sh word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Quote a remote path, keeping a leading `~` / `$HOME` expandable.
 *
 * A plain {@link shellQuote} of `~/git/foo` would send the literal four
 * characters `~/gi…` to a shell that does not expand tilde inside quotes,
 * and the path would not resolve. This mirrors the Kotlin
 * `shellQuoteRemotePathValue`: the `$HOME` prefix is emitted UNQUOTED (so
 * the shell expands it) and everything after it is quoted as data.
 *
 * A blank path means "home", matching the phone.
 */
export function shellQuoteRemotePath(value: string): string {
  const trimmed = value.trim() || '~';
  if (trimmed === '~' || trimmed === '$HOME') return '$HOME';
  if (trimmed.startsWith('~/')) return `$HOME/${shellQuote(trimmed.slice(2))}`;
  if (trimmed.startsWith('$HOME/')) return `$HOME/${shellQuote(trimmed.slice(6))}`;
  return shellQuote(trimmed);
}
