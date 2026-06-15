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
