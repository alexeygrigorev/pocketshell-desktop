/**
 * Git module for PocketShell Desktop.
 *
 * Provides git repository browsing via SSH exec and the
 * pocketshell repos subcommand.
 */

export { GitClient, GitNotRepositoryError, isGitNotRepositoryError } from './git-client';
export { PocketShellRepos } from './pocketshell-repos';
export { parseStatus, parseLog, parseBranches, parseBlame } from './status-parser';
export type {
  GitExecResult,
  GitStatus,
  GitFileStatus,
  GitCommit,
  GitCommitFileChange,
  GitBranch,
  GitPullResult,
  GitBlameLine,
  GitRepoInfo,
  PocketShellRepoLocalInfo,
  PocketShellRepoRemoteInfo,
  PocketShellRepoEntry,
  PocketShellRepoBrowserEntry,
} from './types';
