/**
 * The exact remote shell commands the folder-first session flow runs.
 *
 * They live in their own module, as pure string builders, for one reason:
 * every one of them interpolates a value the user chose (a folder path, a
 * folder name, a repo slug, a session name) into a command line that a remote
 * shell will parse. That is the injection boundary of this feature, so it is
 * a pure function with unit tests rather than a template literal buried in a
 * service method. Every interpolation goes through
 * {@link shellQuote}/{@link shellQuoteRemotePath} — see ../helper/shellQuote.ts.
 *
 * Wrap the result in `pathAwareCommand` (../helper/bootstrap.ts) before
 * exec'ing: sshd runs a non-login shell, so `$HOME/.local/bin` — where uv
 * installs `pocketshell` and `tmuxctl` — is not on PATH by default.
 */

import { shellQuote, shellQuoteRemotePath } from '../helper/shellQuote.js';

/**
 * Ceiling on the `-2`/`-3`… walk in {@link freeSessionNameCommand}. Ported
 * verbatim from `FREE_SESSION_NAME_MAX_SUFFIX` (FolderListGateway.kt:2233):
 * a folder with 200 live sessions is not a real state; the bound only stops a
 * pathological host from spinning the remote shell forever.
 */
export const FREE_SESSION_NAME_MAX_SUFFIX = 200;

/**
 * Is [path] an existing directory? Exit 0 yes, non-zero no.
 *
 * This pre-flight is NOT optional. Re-measured on the Docker fixture (helper
 * 0.4.44): `pocketshell sessions create probe -c "$HOME/no/such/dir"` exits 0
 * and creates a session whose `session_path` is the missing directory — the
 * pane actually lands in `$HOME`. Without this check the desktop would report
 * "session created in ~/git/typo" for a session that is not there. The phone
 * runs the same guard (`remoteStartDirectoryExistsCommand`,
 * FolderListGateway.kt:1233).
 */
export function directoryExistsCommand(path: string): string {
  return `[ -d ${shellQuoteRemotePath(path)} ]`;
}

/** Resolve a remote path to its canonical absolute form (`cd … && pwd -P`). */
export function resolveDirectoryCommand(path: string): string {
  return `cd -- ${shellQuoteRemotePath(path)} && pwd -P`;
}

/** Print the remote `$HOME`. */
export const HOME_COMMAND = 'printf %s "$HOME"';

/**
 * Create a directory (and any missing parents) at [path].
 *
 * `--` terminates option parsing so a folder whose name begins with `-`
 * cannot be read as a flag. Port of `createEmptyProject`
 * (FolderListGateway.kt:1630).
 */
export function mkdirCommand(path: string): string {
  return `mkdir -p -- ${shellQuoteRemotePath(path)}`;
}

/**
 * Does a tmux session named exactly [name] exist? Exit 0 yes.
 *
 * The `=` prefix forces tmux's EXACT match. Without it tmux falls back to
 * prefix then fnmatch matching, so probing `git-foo` while only `git-foo-2`
 * exists answers "taken" — which would make the free-name walk skip a
 * genuinely free name. `2>/dev/null` keeps "no server running" quiet: with no
 * tmux server nothing is taken.
 */
export function sessionExistsCommand(name: string): string {
  return `tmux has-session -t ${shellQuote(`=${name}`)} 2>/dev/null`;
}

/**
 * Print the smallest free name in the `<base>`, `<base>-2`, `<base>-3`… walk,
 * evaluated ENTIRELY on the host in one exec.
 *
 * Port of `freeSessionNameCommand` (FolderListGateway.kt:2245). Running the
 * whole walk remotely means the gap between "this name is free" and "create
 * it" is one command on one connection rather than a seconds-wide window
 * against a client-side cache.
 *
 * [base] is quoted once and then concatenated with `-$i` in the loop, which is
 * safe because POSIX sh concatenates adjacent quoted and unquoted words.
 */
export function freeSessionNameCommand(base: string): string {
  const quoted = shellQuote(base);
  return (
    `__ps_n=${quoted}; __ps_i=2; ` +
    'while tmux has-session -t "=$__ps_n" 2>/dev/null; do ' +
    `if [ "$__ps_i" -gt ${FREE_SESSION_NAME_MAX_SUFFIX} ]; then break; fi; ` +
    `__ps_n=${quoted}-$__ps_i; ` +
    '__ps_i=$((__ps_i+1)); ' +
    "done; printf '%s\\n' \"$__ps_n\""
  );
}

/**
 * `pocketshell sessions create '<name>' -c '<cwd>'`.
 *
 * `--mem` is deliberately NOT passed. Confirmed against the helper's own
 * `sessions create --help` on the fixture: "`--mem` is intentionally UNSET by
 * default so tmuxctl resolves the per-project cap from the repo's
 * cgroups.toml". The phone says the same thing at FolderListGateway.kt:2148.
 * Passing a number here would override a budget the repo declared for itself.
 *
 * The helper prints the resolved session name on stdout and exits 0; the
 * create is idempotent (a no-op when the session already exists).
 */
export function createSessionCommand(name: string, cwd: string): string {
  return `pocketshell sessions create ${shellQuote(name)} -c ${shellQuoteRemotePath(cwd)}`;
}

/**
 * The helper-absent fallback: raw `tmux new-session -A -d`.
 *
 * `-A` = attach-if-exists, which on a detached create means "succeed as a
 * no-op", preserving the same idempotency the helper's `create-detached` has.
 * `-d` = leave it detached; we attach over our own PTY afterwards.
 *
 * Note this is ONE fallback layer, not the phone's two. See the
 * `createSession` doc comment in ../helper/PocketshellClient.ts.
 */
export function fallbackCreateSessionCommand(name: string, cwd: string): string {
  return `tmux new-session -A -d -s ${shellQuote(name)} -c ${shellQuoteRemotePath(cwd)}`;
}

/** Options for {@link reposListCommand}. */
export interface ReposListOptions {
  /** Scan the local filesystem, or ask GitHub via `gh`. */
  scope: 'local' | 'remote';
  /** Scan roots, `--local` only. Replaces (does not augment) the default `~/git`. */
  roots?: string[];
  /** Directory depth for the local scan. Helper default is 4. */
  maxDepth?: number;
  /** Cap on remote repositories returned, `--remote` only. */
  limit?: number;
}

/**
 * `pocketshell repos list --local|--remote --json …`.
 *
 * The scope flag is ALWAYS passed explicitly. With neither flag the helper
 * defaults to `--local` and prints a discoverability hint ("defaulting to
 * --local…") alongside the rows — a naive parser would eat it.
 */
export function reposListCommand(options: ReposListOptions): string {
  const parts = ['pocketshell repos list', `--${options.scope}`, '--json'];
  if (options.scope === 'local') {
    for (const root of options.roots ?? []) {
      if (root.trim().length > 0) parts.push('--root', shellQuoteRemotePath(root));
    }
    if (options.maxDepth != null && Number.isInteger(options.maxDepth) && options.maxDepth > 0) {
      parts.push('--max-depth', String(options.maxDepth));
    }
  } else if (options.limit != null && Number.isInteger(options.limit) && options.limit > 0) {
    parts.push('--limit', String(options.limit));
  }
  return parts.join(' ');
}

/** Options for {@link reposCloneCommand}. */
export interface ReposCloneOptions {
  /** `owner/repo`. */
  repository: string;
  /** Clone root. Helper default is `~/git`. */
  root?: string;
  /** Target folder name under the root. Helper default is the repo name. */
  folder?: string;
  /** Clone URL protocol. Helper default is `ssh`. */
  protocol?: 'ssh' | 'https';
}

/**
 * `pocketshell repos clone <owner/repo> …`. Prints the created path on stdout.
 *
 * `repository` is quoted like every other argument even though it "should" be
 * a tame `owner/repo` slug — it arrives from the renderer, and a value that
 * only ever comes from a list today is exactly the one that comes from a text
 * field tomorrow.
 */
export function reposCloneCommand(options: ReposCloneOptions): string {
  const parts = ['pocketshell repos clone', shellQuote(options.repository)];
  if (options.root != null && options.root.trim().length > 0) {
    parts.push('--root', shellQuoteRemotePath(options.root));
  }
  if (options.folder != null && options.folder.trim().length > 0) {
    parts.push('--folder', shellQuote(options.folder.trim()));
  }
  if (options.protocol) parts.push('--protocol', options.protocol);
  return parts.join(' ');
}
