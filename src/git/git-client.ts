/**
 * Git client for PocketShell Desktop.
 *
 * Executes remote git commands over SSH and parses the output
 * into structured types using pure parser functions.
 */

import type { SshConnection, ExecResult } from '../ssh/connection/ssh-client';
import type {
  GitExecResult,
  GitStatus,
  GitCommit,
  GitBranch,
  GitWorktree,
  GitPullResult,
  GitBlameLine,
  GitHubIssue,
  GhStatus,
} from './types';
import {
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

// ---------------------------------------------------------------------------
// Format constants for git commands
// ---------------------------------------------------------------------------

/**
 * Log format: fields separated by NUL (\x00), commits delimited by "ENDCOMMIT\0".
 * Fields: hash, shortHash, author, authorEmail, date (ISO), subject, body
 */
const LOG_FORMAT = 'ENDCOMMIT%x00%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b%x00';

/** Default issue listing cap — keeps a giant project's list manageable (app DEFAULT_ISSUE_LIMIT). */
const DEFAULT_ISSUE_LIMIT = 50;

/** Hard ceiling on the issue listing limit passed to `gh issue list` (app MAX_ISSUE_LIMIT). */
const MAX_ISSUE_LIMIT = 200;

// ---------------------------------------------------------------------------
// GitClient
// ---------------------------------------------------------------------------

export class GitClient {
  private connection: SshConnection;

  constructor(connection: SshConnection) {
    this.connection = connection;
  }

  /**
   * Execute a git command over SSH.
   *
   * @param command - git subcommand and arguments
   * @param cwd - working directory on the remote host
   */
  async exec(command: string, cwd?: string): Promise<GitExecResult> {
    const fullCommand = cwd
      ? `cd ${quote(cwd)} && ${command}`
      : command;

    const result: ExecResult = await this.connection.exec(fullCommand);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Repository operations
  // -------------------------------------------------------------------------

  /** Clone a repository. */
  async clone(url: string, path: string): Promise<void> {
    const result = await this.exec(`git clone ${quote(url)} ${quote(path)}`);
    if (result.exitCode !== 0) {
      throwGitCommandError('git clone', result.stderr);
    }
  }

  /** Get the working tree status. */
  async status(cwd: string): Promise<GitStatus> {
    const result = await this.exec(
      'git status --porcelain=v2 --branch',
      cwd,
    );
    if (result.exitCode !== 0) {
      throwGitCommandError('git status', result.stderr);
    }
    return parseStatus(result.stdout);
  }

  /** Get commit log. */
  async log(
    cwd: string,
    options?: { maxCount?: number; branch?: string },
  ): Promise<GitCommit[]> {
    const maxCount = options?.maxCount ?? 50;
    const branch = options?.branch;

    let cmd = `git log --format=${LOG_FORMAT} -n ${maxCount}`;
    cmd += ' --numstat';
    if (branch) {
      cmd += ` ${quote(branch)}`;
    }

    const result = await this.exec(cmd, cwd);
    if (result.exitCode !== 0) {
      throwGitCommandError('git log', result.stderr);
    }
    return parseLog(result.stdout);
  }

  /** Get diff output. */
  async diff(
    cwd: string,
    options?: { file?: string; cached?: boolean },
  ): Promise<string> {
    let cmd = 'git diff';
    if (options?.cached) {
      cmd += ' --cached';
    }
    if (options?.file) {
      cmd += ` -- ${quote(options.file)}`;
    }

    const result = await this.exec(cmd, cwd);
    if (result.exitCode !== 0) {
      throwGitCommandError('git diff', result.stderr);
    }
    return result.stdout;
  }

  /** List branches. */
  async branches(cwd: string): Promise<GitBranch[]> {
    const result = await this.exec('git branch -a -vv', cwd);
    if (result.exitCode !== 0) {
      throwGitCommandError('git branch', result.stderr);
    }
    return parseBranches(result.stdout);
  }

  /** List worktrees (`git worktree list --porcelain`). */
  async worktree(cwd: string): Promise<GitWorktree[]> {
    const result = await this.exec('git worktree list --porcelain', cwd);
    if (result.exitCode !== 0) {
      throwGitCommandError('git worktree', result.stderr);
    }
    return parseWorktree(result.stdout);
  }

  /**
   * Get the fetch URL of a remote (default `origin`). Returns the trimmed URL
   * or undefined if the remote is not configured. Used by the git-history panel
   * to detect a GitHub remote for the "Open on GitHub" action.
   */
  async remoteUrl(cwd: string, remote: string = 'origin'): Promise<string | undefined> {
    const result = await this.exec(
      `git remote get-url ${quote(remote)}`,
      cwd,
    );
    if (result.exitCode !== 0) {
      return undefined;
    }
    const url = result.stdout.trim();
    return url || undefined;
  }

  /** Get the current branch name. */
  async currentBranch(cwd: string): Promise<string> {
    const result = await this.exec(
      'git rev-parse --abbrev-ref HEAD',
      cwd,
    );
    if (result.exitCode !== 0) {
      throwGitCommandError('git current-branch', result.stderr);
    }
    return result.stdout.trim();
  }

  /** Checkout a ref (branch, tag, or commit). */
  async checkout(cwd: string, ref: string): Promise<void> {
    const result = await this.exec(`git checkout ${quote(ref)}`, cwd);
    if (result.exitCode !== 0) {
      throwGitCommandError('git checkout', result.stderr);
    }
  }

  /** Fetch from a remote. */
  async fetch(cwd: string, remote?: string): Promise<void> {
    const cmd = remote
      ? `git fetch ${quote(remote)}`
      : 'git fetch';
    const result = await this.exec(cmd, cwd);
    if (result.exitCode !== 0) {
      throwGitCommandError('git fetch', result.stderr);
    }
  }

  /** Pull changes from the upstream. */
  async pull(cwd: string): Promise<GitPullResult> {
    const result = await this.exec('git pull', cwd);
    if (result.exitCode !== 0) {
      throwGitCommandError('git pull', result.stderr);
    }
    return parsePullResult(result.stdout);
  }

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------

  /** Show file contents at a specific ref. */
  async show(cwd: string, ref: string, path: string): Promise<string> {
    const result = await this.exec(
      `git show ${quote(ref + ':' + path)}`,
      cwd,
    );
    if (result.exitCode !== 0) {
      throwGitCommandError('git show', result.stderr);
    }
    return result.stdout;
  }

  /** Blame a file. */
  async blame(cwd: string, path: string): Promise<GitBlameLine[]> {
    const result = await this.exec(
      `git blame --porcelain ${quote(path)}`,
      cwd,
    );
    if (result.exitCode !== 0) {
      throwGitCommandError('git blame', result.stderr);
    }
    return parseBlame(result.stdout);
  }

  // -------------------------------------------------------------------------
  // GitHub issues (app §6 Issues tab — `gh issue list` / `pocketshell github status`)
  // -------------------------------------------------------------------------

  /**
   * Probe whether the GitHub CLI (`gh`) is installed AND authenticated on the
   * remote, via the `pocketshell github status --json` helper subcommand (app
   * §6 / #645). Mirrors the app's `GitHistoryGateway.ghStatus`.
   *
   * The helper ALWAYS exits 0 (gh-missing / not-authed are normal reportable
   * states, not errors) and emits a `{installed, authenticated, account, hint}`
   * JSON envelope. When `pocketshell` itself is missing (exit 127) we still
   * return a not-configured status with the pocketshell-missing hint, since the
   * issue list can't be fetched either way. Any other failure degrades to the
   * default gh hint so the panel shows the configure-gh prompt, never a crash.
   */
  async ghStatus(): Promise<GhStatus> {
    let result: ExecResult;
    try {
      result = await this.connection.exec('pocketshell github status --json');
    } catch {
      return { installed: false, authenticated: false, hint: DEFAULT_GH_HINT };
    }
    if (result.exitCode === 127) {
      return { installed: false, authenticated: false, hint: POCKETSHELL_MISSING_HINT };
    }
    return parseGhStatus(result.stdout);
  }

  /**
   * List the repo's GitHub issues via `gh issue list --json …` over SSH (app
   * §6 / #649). Mirrors the app's `GitHistoryGateway.listIssues` faithfully:
   * `cd` into the repo so gh resolves the GitHub repo from the directory's
   * origin remote, request `number,title,state,labels,updatedAt`, `--state all`,
   * capped at [limit] (default 50). The caller MUST have already gated on
   * `ghStatus()` — this assumes gh is usable.
   *
   * Throws on non-zero exit (e.g. not a GitHub repo, no network) so the panel
   * can surface a neutral "issues unavailable" state. A clean empty listing
   * (`[]`) succeeds with an empty array so the panel shows its empty state.
   */
  async listIssues(
    cwd: string,
    options: { limit?: number } = {},
  ): Promise<GitHubIssue[]> {
    const safeLimit = Math.max(1, Math.min(Math.trunc(options.limit ?? DEFAULT_ISSUE_LIMIT), MAX_ISSUE_LIMIT));
    const cmd = `gh issue list --json number,title,state,labels,updatedAt --state all --limit ${safeLimit}`;
    const result = await this.exec(cmd, cwd);
    if (result.exitCode !== 0) {
      throwGitCommandError('gh issue list', result.stderr);
    }
    return parseGitHubIssues(result.stdout);
  }
}

export class GitNotRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitNotRepositoryError';
  }
}

export function isGitNotRepositoryError(err: unknown): err is GitNotRepositoryError {
  return err instanceof GitNotRepositoryError;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quote a shell argument with single quotes. */
function quote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function throwGitCommandError(command: string, stderr: string): never {
  if (isNotRepositoryMessage(stderr)) {
    throw new GitNotRepositoryError(`${command} failed: ${stderr}`);
  }
  if (isGitNotFound(stderr)) {
    throw new Error(
      `${command} failed: 'git' is not installed or not on PATH on the ` +
        `remote host (install git on the host and retry).`,
    );
  }
  throw new Error(`${command} failed: ${stderr}`);
}

function isNotRepositoryMessage(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

/** Detect a missing remote `git` binary from its stderr text. */
function isGitNotFound(stderr: string): boolean {
  return /git: (command )?not found|command not found: git/i.test(stderr);
}

/**
 * Parse `git pull` output into a GitPullResult.
 *
 * Typical output:
 *   From https://github.com/user/repo
 *      abc1234..def5678  main       -> origin/main
 *   Updating abc1234..def5678
 *   Fast-forward
 *    file1.txt | 3 ++-
 *    file2.txt | 10 +++++++++-
 *    2 files changed, 12 insertions(+), 1 deletion(-)
 */
function parsePullResult(output: string): GitPullResult {
  const updated: string[] = [];
  let insertions = 0;
  let deletions = 0;

  const lines = output.split('\n');

  for (const line of lines) {
    // Match file change lines: " path | N ..." or " path | Bin ..."
    const fileMatch = line.match(/^\s+(\S+(?:\s+\S+)*)\s+\|/);
    if (fileMatch) {
      const path = fileMatch[1].replace(/{.*? => (.*?)}/, '$1');
      updated.push(path);
    }

    // Match summary line: "N files changed, M insertions(+), K deletions(-)"
    const summaryMatch = line.match(
      /(\d+) files? changed(?:, (\d+) insertions?\([^)]*\))?(?:, (\d+) deletions?\([^)]*\))?/,
    );
    if (summaryMatch) {
      insertions = parseInt(summaryMatch[2] || '0', 10);
      deletions = parseInt(summaryMatch[3] || '0', 10);
    }
  }

  return { updated, insertions, deletions };
}
