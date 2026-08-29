/**
 * Which repository a session's working directory belongs to
 *
 *
 * Pure: this parses the output of `gitRepoProbeCommand` and decides what to do
 * with it. The exec, the batching and the caching are the client's job
 * (../helper/PocketshellClient.ts), which is what lets every rule below be
 * tested without a host or a git.
 *
 * ## The rule, in one line
 *
 * A LINKED WORKTREE is remapped to its main repository's root. Everything else
 * is left exactly where it is.
 *
 * ## Why only worktrees
 *
 * The probe compares `--git-dir` with `--git-common-dir`. For a normal checkout
 * the two are equal — at the repository root and at every depth below it. They
 * differ only inside a linked worktree, where `--git-dir` is
 * `<main>/.git/worktrees/<name>` and `--git-common-dir` is `<main>/.git`.
 *
 * Using the common dir alone would have been simpler and would have swept up
 * subdirectories too: a session in `~/git/monorepo/pkg-a` would group under
 * `monorepo`. That is a real design choice and it is deliberately NOT made
 * here. The user asked for one thing — a worktree filed under its repository —
 * and merging every subdirectory session into its repo root would silently
 * collapse folders that people organise on purpose.
 *
 * ## Why the probe reports an INDEX and not a path
 *
 * The first version had the host print `dir::gitdir::commondir` and split the
 * fields from both ends, on the reasoning that only the user-named directory
 * could contain a `::`. That reasoning is wrong, and the test that was written
 * to prove it is what showed it: the two git answers are paths INSIDE the
 * directory being asked about, so if it contains `::` then so do they, and no
 * amount of splitting from either end can tell the three apart.
 *
 * So the host prints the REQUEST INDEX instead — digits, which cannot be
 * ambiguous — and the caller maps it back to the path it sent. The host also
 * does the equality test itself and prints nothing for a non-worktree, which
 * leaves exactly one path-shaped field on the line, at the end, where a single
 * split on the FIRST delimiter recovers it whatever it contains.
 */

/** The `::` delimiter, matching the rest of this app's host probes. */
const FIELD_SEP = '::';

/**
 * The repository root a `--git-common-dir` value implies.
 *
 * Normally that is the parent of the `.git` directory. A BARE repository is the
 * exception and is returned unchanged: its git dir IS the repository, there is
 * no working tree above it, and stripping a component would name a directory
 * that has nothing to do with it.
 */
export function repoRootFromCommonDir(commonDir: string): string {
  const trimmed = commonDir.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut <= 0) return trimmed;
  const leaf = trimmed.slice(cut + 1);
  return leaf === '.git' ? trimmed.slice(0, cut) : trimmed;
}

/**
 * Parse the probe's `<index>::<commonDir>` lines into worktree -> repo root.
 *
 * [requested] must be the exact list, in the exact order, that was passed to
 * `gitRepoProbeCommand` — the index is a position in it. An index that is not a
 * number, or that is out of range, is dropped: it can only mean the output and
 * the request have gone out of step, and inventing a mapping from that would
 * file a session under a repository chosen at random.
 *
 * A directory that is not a worktree is ABSENT from the map rather than mapped
 * to itself. Absence is what the caller wants: it can then use `??` to fall
 * back to the session's own path, and "not a worktree", "not a repo", "git is
 * not installed" and "the probe failed" all collapse into the same, correct,
 * do-nothing answer.
 */
export function parseWorktreeRoots(
  stdout: string,
  requested: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cut = line.indexOf(FIELD_SEP);
    if (cut <= 0) continue;
    const index = Number.parseInt(line.slice(0, cut), 10);
    // `Number.parseInt` would happily read `12abc` as 12, so the field is
    // checked for being ALL digits rather than merely starting with one — a
    // stray log line beginning with a number must not be read as a row.
    if (!/^\d+$/.test(line.slice(0, cut))) continue;
    const dir = requested[index];
    if (dir === undefined) continue;
    const commonDir = line.slice(cut + FIELD_SEP.length);
    if (!commonDir) continue;
    const root = repoRootFromCommonDir(commonDir);
    // A mapping from a directory to itself is a no-op that would still cost a
    // `repoRoot` field on the row, and would read in the log as a remap that
    // did not happen.
    if (!root || root === dir) continue;
    out.set(dir, root);
  }
  return out;
}
