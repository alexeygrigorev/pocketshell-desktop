/**
 * PocketShell Repos adapter for PocketShell Desktop.
 *
 * Uses the `pocketshell repos` subcommand over SSH to manage
 * registered git repositories on the remote host.
 */

import type { SshConnection } from '../ssh/connection/ssh-client';
import type { GitRepoInfo } from './types';
import { GitClient } from './git-client';

// ---------------------------------------------------------------------------
// PocketShellRepos
// ---------------------------------------------------------------------------

export class PocketShellRepos {
  private connection: SshConnection;

  constructor(connection: SshConnection) {
    this.connection = connection;
  }

  /**
   * List registered repos via `pocketshell repos list`.
   */
  async list(): Promise<GitRepoInfo[]> {
    const result = await this.connection.exec('pocketshell repos list');
    if (result.exitCode !== 0) {
      throw new Error(`pocketshell repos list failed: ${result.stderr}`);
    }

    const paths = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const repos: GitRepoInfo[] = [];

    for (const repoPath of paths) {
      const info = await this.getRepoInfo(repoPath);
      if (info) {
        repos.push(info);
      }
    }

    return repos;
  }

  /**
   * Register a repo via `pocketshell repos add <path>`.
   */
  async register(path: string): Promise<void> {
    const result = await this.connection.exec(
      `pocketshell repos add ${quoteArg(path)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `pocketshell repos add failed: ${result.stderr}`,
      );
    }
  }

  /**
   * Unregister a repo via `pocketshell repos remove <path>`.
   */
  async unregister(path: string): Promise<void> {
    const result = await this.connection.exec(
      `pocketshell repos remove ${quoteArg(path)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `pocketshell repos remove failed: ${result.stderr}`,
      );
    }
  }

  /**
   * Get status for a specific repo.
   */
  async status(path: string): Promise<GitRepoInfo> {
    const info = await this.getRepoInfo(path);
    if (!info) {
      throw new Error(`Cannot get repo info for: ${path}`);
    }
    return info;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Gather GitRepoInfo for a repo path by running git commands.
   */
  private async getRepoInfo(repoPath: string): Promise<GitRepoInfo | null> {
    const gitClient = new GitClient(this.connection);

    try {
      // Get branch name
      let headBranch = '';
      try {
        headBranch = await gitClient.currentBranch(repoPath);
      } catch {
        headBranch = '(unknown)';
      }

      // Get status (to check if dirty)
      let isDirty = false;
      try {
        const status = await gitClient.status(repoPath);
        isDirty = !status.isClean;
      } catch {
        isDirty = false;
      }

      // Get remote URL
      let remoteUrl: string | undefined;
      try {
        const remoteResult = await gitClient.exec(
          'git remote get-url origin',
          repoPath,
        );
        if (remoteResult.exitCode === 0) {
          remoteUrl = remoteResult.stdout.trim();
        }
      } catch {
        // No remote configured
      }

      // Extract repo name from path
      const name = repoPath.split('/').filter(Boolean).pop() || repoPath;

      return {
        path: repoPath,
        name,
        headBranch,
        isDirty,
        remoteUrl,
      };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quote a shell argument with single quotes. */
function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
