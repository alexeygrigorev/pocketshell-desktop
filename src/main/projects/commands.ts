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

/**
 * Rename tmux session [from] to [to] (docs/WORKSPACE.md §4).
 *
 * ## Why raw tmux and not the helper
 *
 * The helper has no rename verb, and it does not need one. `attachCommand.ts`
 * establishes — with the correction at the top of that file — that tmuxctl
 * shells out to a bare `tmux` on the DEFAULT socket, so a raw tmux command
 * reaches the same server the helper's sessions live on. `sessionSwitchCommand`
 * already relies on exactly that. This is the same mechanism, aimed at a name
 * instead of at a client.
 *
 * ## Why both `=` prefixes matter
 *
 * tmux's `-t` is a prefix-then-fnmatch match unless the target begins with `=`.
 * Without it, renaming `api` on a host that also runs `api-staging` would pick
 * whichever tmux resolved first — so the `=` is what makes "rename THIS
 * session" mean this session. `sessionExistsCommand` above carries the same
 * note for the same reason.
 *
 * ## Why `--`
 *
 * The new name is the one argument here that is not option-position-safe: a
 * name beginning with `-` would be read as a flag. `sanitisePart` strips
 * leading `-`, so this app cannot produce such a name — but this builder is the
 * injection boundary and it should not depend on a caller upstream having
 * sanitised correctly.
 */
export function renameSessionCommand(from: string, to: string): string {
  return `tmux rename-session -t ${shellQuote(`=${from}`)} -- ${shellQuote(to)}`;
}

/**
 * Ask git, for each of [paths], which repository it belongs to
 * (docs/WORKSPACE.md §6.5).
 *
 * ## Why this exists
 *
 * The user selected a folder called `merry-sniffing-token`, whose only session
 * is named `git-dtc-website-decisions`, and said: "this one should be in
 * dtc-website actually". That directory is a git WORKTREE of
 * `~/git/dtc-website`, and a worktree belongs with the repository it is a
 * worktree OF — which is also why the session carries that name, since it was
 * created against that repo. The name was telling us the answer all along and
 * the grouping was ignoring it in favour of the raw cwd.
 *
 * It is resolved by ASKING GIT rather than by parsing the name, because the
 * name cannot answer it: `-` is both the component separator and a legal
 * character inside a component, so `git-dtc-website-decisions` is ambiguous
 * between several paths (the same reason `rootFromSessionName` refuses to
 * invert past the first component).
 *
 * ## Why two queries per directory, not one
 *
 * `--git-common-dir` alone would over-reach. It answers "which repository is
 * this", so it maps a SUBDIRECTORY of a repo to the repo root too — meaning
 * sessions in `~/git/monorepo/pkg-a` and `~/git/monorepo/pkg-b` would collapse
 * into one folder. That is a much bigger behaviour change than the user asked
 * for and not obviously wanted.
 *
 * `--git-dir` is what makes the query precise. For a normal checkout — at the
 * root or anywhere below it — the two are EQUAL. Only in a linked worktree do
 * they differ: `--git-dir` is `<main>/.git/worktrees/<name>` while
 * `--git-common-dir` is `<main>/.git`. So emitting both lets the parser remap
 * worktrees and leave every other directory exactly where it is today.
 *
 * ## Why no `--path-format=absolute`
 *
 * That flag needs git 2.31+, and it turns out to be unnecessary. Both values
 * are resolved by `cd`-ing to them FROM the directory being asked about, which
 * handles the absolute and relative forms identically and costs nothing — so
 * there is no version gate, no fallback branch, and nothing to degrade.
 * `pwd -P` then resolves symlinks, so the two can be compared as strings.
 *
 * ## Why the host does the comparison, and prints an INDEX
 *
 * The output is `<index>::<commonDir>`, emitted ONLY for a directory that is a
 * worktree. Both halves of that are about parsing, and both were learned the
 * hard way (see ../projects/worktrees.ts): a directory path can contain the
 * `::` delimiter, and if it does then so do the two git answers, because they
 * are paths inside it. Printing all three fields is therefore unparseable in
 * principle, not merely awkward. Printing the request index — digits — plus a
 * single trailing path leaves exactly one ambiguous field, at the end, which a
 * split on the FIRST delimiter recovers whatever it contains.
 *
 * One exec for every directory, not one per directory: the same discipline the
 * session-enrichment probe and the port scanner already follow. A directory
 * that is not in a repository, or that git cannot read, prints nothing and is
 * simply absent from the result.
 */
export function gitRepoProbeCommand(paths: readonly string[]): string {
  const quoted = paths.map(shellQuoteRemotePath).join(' ');
  return (
    '__ps_i=0; ' +
    `for __ps_d in ${quoted}; do ` +
    '__ps_n=$__ps_i; __ps_i=$((__ps_i+1)); ' +
    '__ps_g=$(cd "$__ps_d" 2>/dev/null && git rev-parse --git-dir 2>/dev/null) || continue; ' +
    '[ -n "$__ps_g" ] || continue; ' +
    '__ps_c=$(cd "$__ps_d" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null) || continue; ' +
    '[ -n "$__ps_c" ] || continue; ' +
    '__ps_ga=$(cd "$__ps_d" && cd "$__ps_g" 2>/dev/null && pwd -P) || continue; ' +
    '__ps_ca=$(cd "$__ps_d" && cd "$__ps_c" 2>/dev/null && pwd -P) || continue; ' +
    // Equal means an ordinary checkout at any depth: say nothing, so the
    // caller leaves the session exactly where it is.
    '[ "$__ps_ga" != "$__ps_ca" ] || continue; ' +
    "printf '%s::%s\\n' \"$__ps_n\" \"$__ps_ca\"; " +
    'done'
  );
}
