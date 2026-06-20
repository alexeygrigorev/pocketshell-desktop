/**
 * Git types for PocketShell Desktop.
 *
 * Data types used by GitClient, PocketShellRepos, and status parsers.
 */

// ---------------------------------------------------------------------------
// Git operation result
// ---------------------------------------------------------------------------

/** Result of executing a git command over SSH. */
export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Git status
// ---------------------------------------------------------------------------

/** File status within a git working tree. */
export interface GitFileStatus {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  /** Original path for renames. */
  oldPath?: string;
}

/** Result of `git status --porcelain=v2 --branch`. */
export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: string[];
  isClean: boolean;
}

// ---------------------------------------------------------------------------
// Git log
// ---------------------------------------------------------------------------

/** A single commit from `git log`. */
export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  /** ISO 8601 date string. */
  date: string;
  subject: string;
  body?: string;
  files: GitCommitFileChange[];
}

/** Changed-file summary for a commit from `git log --numstat`. */
export interface GitCommitFileChange {
  path: string;
  oldPath?: string;
  insertions?: number;
  deletions?: number;
  binary: boolean;
}

// ---------------------------------------------------------------------------
// Git branches
// ---------------------------------------------------------------------------

/** A branch entry from `git branch -a`. */
export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  /** Upstream tracking branch. */
  tracking?: string;
}

// ---------------------------------------------------------------------------
// Git worktrees
// ---------------------------------------------------------------------------

/** A worktree entry from `git worktree list --porcelain`. */
export interface GitWorktree {
  /** Absolute path to the worktree on the remote host. */
  path: string;
  /** HEAD commit hash of the worktree. */
  head?: string;
  /** Branch checked out in the worktree (bare `refs/heads/<name>`). */
  branch?: string;
  /** True when the worktree is the main one (first listed, marked `main`). */
  isMain: boolean;
  /** True for a bare repository worktree. */
  isBare: boolean;
  /** True when the worktree is marked locked (`locked` porcelain field). */
  isLocked: boolean;
  /** True when the worktree is prunable (`prunable` porcelain field). */
  isPrunable: boolean;
  /** Optional reason given after `locked`/`prunable`. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Git pull
// ---------------------------------------------------------------------------

/** Result of `git pull`. */
export interface GitPullResult {
  /** Files updated by the pull. */
  updated: string[];
  insertions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// Git blame
// ---------------------------------------------------------------------------

/** A single line from `git blame --porcelain`. */
export interface GitBlameLine {
  line: number;
  hash: string;
  author: string;
  date: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Git repo info (from pocketshell repos)
// ---------------------------------------------------------------------------

/** Summary of a registered git repository. */
export interface GitRepoInfo {
  path: string;
  name: string;
  headBranch: string;
  isDirty: boolean;
  remoteUrl?: string;
}

/** Local clone metadata returned by `pocketshell repos list --local --json`. */
export interface PocketShellRepoLocalInfo {
  path: string;
  head?: string;
}

/** GitHub metadata returned by `pocketshell repos list --remote --json`. */
export interface PocketShellRepoRemoteInfo {
  defaultBranch?: string;
  htmlUrl?: string;
  sshUrl?: string;
  updatedAt?: string;
}

/** Unified repo entry returned by the pocketshell helper. */
export interface PocketShellRepoEntry {
  owner?: string;
  name: string;
  fullName?: string;
  local?: PocketShellRepoLocalInfo;
  remote?: PocketShellRepoRemoteInfo;
}

/** Merged row for a GitHub repo and/or an existing local clone. */
export interface PocketShellRepoBrowserEntry {
  fullName: string;
  name: string;
  owner?: string;
  cloned: boolean;
  path?: string;
  defaultBranch?: string;
  updatedAt?: string;
  remote?: PocketShellRepoRemoteInfo;
}

// ---------------------------------------------------------------------------
// GitHub issues (app §6 Issues tab — `gh issue list` / `pocketshell github status`)
// ---------------------------------------------------------------------------

/** Open / closed state of a GitHub issue. `unknown` is forward-compatible. */
export type GitHubIssueState = 'open' | 'closed' | 'unknown';

/**
 * One GitHub issue row from `gh issue list --json number,title,state,labels,updatedAt`.
 * A read-only projection mirroring the app's `GitHubIssue` data class: enough to
 * render the row (number, title, state, labels, updatedAt) without pulling the
 * body or comments.
 */
export interface GitHubIssue {
  /** Issue number, e.g. `649`. Always >= 1 from gh. */
  number: number;
  /** Issue title (first line of the row). */
  title: string;
  /** Open vs closed — drives the status badge. */
  state: GitHubIssueState;
  /** Label names attached to the issue (may be empty). */
  labels: string[];
  /** Raw `updatedAt` ISO-8601 timestamp from gh, or undefined when absent. */
  updatedAt?: string;
}

/**
 * gh install/auth status envelope from `pocketshell github status --json`.
 * Mirrors the app's `GhConfigStatus` sealed interface: `configured === true`
 * means gh is installed AND authenticated; otherwise `hint` carries the
 * actionable "configure gh" message.
 */
export interface GhStatus {
  /** True when `gh` is on PATH on the remote host. */
  installed: boolean;
  /** True when `gh auth status` exits 0 (a valid token is present). */
  authenticated: boolean;
  /** Logged-in GitHub username when authenticated, else undefined. */
  account?: string;
  /** Actionable hint when NOT configured, else undefined. */
  hint?: string;
}
