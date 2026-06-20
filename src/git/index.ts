/**
 * Git module for PocketShell Desktop.
 *
 * Provides git repository browsing via SSH exec and the
 * pocketshell repos subcommand.
 */

export { GitClient, GitNotRepositoryError, isGitNotRepositoryError } from './git-client';
export { PocketShellRepos } from './pocketshell-repos';
export {
  parseStatus,
  parseLog,
  parseBranches,
  parseWorktree,
  parseBlame,
  parseGitHubIssues,
  parseGhStatus,
  DEFAULT_GH_HINT,
  POCKETSHELL_MISSING_HINT,
} from './status-parser';
export type {
  GitExecResult,
  GitStatus,
  GitFileStatus,
  GitCommit,
  GitCommitFileChange,
  GitBranch,
  GitWorktree,
  GitPullResult,
  GitBlameLine,
  GitRepoInfo,
  PocketShellRepoLocalInfo,
  PocketShellRepoRemoteInfo,
  PocketShellRepoEntry,
  PocketShellRepoBrowserEntry,
  GitHubIssue,
  GitHubIssueState,
  GhStatus,
} from './types';
