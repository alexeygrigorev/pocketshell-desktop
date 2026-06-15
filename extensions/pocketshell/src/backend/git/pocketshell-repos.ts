/**
 * PocketShell Repos adapter for PocketShell Desktop.
 *
 * Uses the `pocketshell repos` subcommand over SSH to manage
 * registered git repositories on the remote host.
 */

import type { SshConnection } from '../ssh/connection/ssh-client';
import type {
  GitRepoInfo,
  PocketShellRepoBrowserEntry,
  PocketShellRepoEntry,
  PocketShellRepoLocalInfo,
  PocketShellRepoRemoteInfo,
} from './types';
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
   * List GitHub repos visible to the authenticated `gh` user on the host.
   */
  async listRemote(options: { limit?: number } = {}): Promise<PocketShellRepoEntry[]> {
    const limit = options.limit !== undefined
      ? ` --limit ${Math.max(1, Math.trunc(options.limit))}`
      : '';
    const result = await this.connection.exec(
      `pocketshell repos list --remote --json${limit}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`pocketshell repos list --remote failed: ${failureText(result)}`);
    }
    return parseRepoListJson(result.stdout);
  }

  /**
   * List local clones discovered by the pocketshell helper.
   */
  async listLocal(options: { root?: string } = {}): Promise<PocketShellRepoEntry[]> {
    const root = options.root ? ` --root ${quoteArg(options.root)}` : '';
    const result = await this.connection.exec(
      `pocketshell repos list --local --json${root}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`pocketshell repos list --local failed: ${failureText(result)}`);
    }
    return parseRepoListJson(result.stdout);
  }

  /**
   * List GitHub repos joined with local clone state.
   */
  async browse(options: { limit?: number; localRoot?: string } = {}): Promise<PocketShellRepoBrowserEntry[]> {
    const [remote, local] = await Promise.all([
      this.listRemote({ limit: options.limit }),
      this.listLocal({ root: options.localRoot }),
    ]);
    return mergeRepoEntries(remote, local);
  }

  /**
   * Resolve an existing local clone path for a GitHub `owner/repo`.
   */
  async open(fullName: string): Promise<string> {
    const result = await this.connection.exec(
      `pocketshell repos open ${quoteArg(fullName)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`pocketshell repos open failed: ${failureText(result)}`);
    }
    return parseRepoPath(result.stdout);
  }

  /**
   * Clone a GitHub `owner/repo` into `root` and return the clone path.
   */
  async clone(fullName: string, root: string): Promise<string> {
    const result = await this.connection.exec(
      `pocketshell repos clone ${quoteArg(fullName)} --root ${quoteArg(root)} --protocol ssh`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`pocketshell repos clone failed: ${failureText(result)}`);
    }
    return parseRepoPath(result.stdout);
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

function failureText(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim();
}

function parseRepoPath(stdout: string): string {
  const path = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!path) {
    throw new Error('pocketshell repos returned an empty path');
  }
  return path;
}

function parseRepoListJson(stdout: string): PocketShellRepoEntry[] {
  const text = stdout.trim();
  const parsed = JSON.parse(text || '[]') as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('pocketshell repos JSON is not an array');
  }
  return parsed.map(parseRepoEntry);
}

function parseRepoEntry(value: unknown): PocketShellRepoEntry {
  if (!value || typeof value !== 'object') {
    throw new Error('pocketshell repos entry is not an object');
  }
  const obj = value as Record<string, unknown>;
  const name = stringValue(obj.name);
  if (!name) {
    throw new Error('pocketshell repos entry is missing name');
  }
  return {
    owner: stringValue(obj.owner),
    name,
    fullName: stringValue(obj.full_name) ?? stringValue(obj.fullName),
    local: parseLocalInfo(obj.local),
    remote: parseRemoteInfo(obj.remote),
  };
}

function parseLocalInfo(value: unknown): PocketShellRepoLocalInfo | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const path = stringValue(obj.path);
  if (!path) {
    return undefined;
  }
  return {
    path,
    head: stringValue(obj.head),
  };
}

function parseRemoteInfo(value: unknown): PocketShellRepoRemoteInfo | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  return {
    defaultBranch: stringValue(obj.default_branch) ?? stringValue(obj.defaultBranch),
    htmlUrl: stringValue(obj.html_url) ?? stringValue(obj.htmlUrl),
    sshUrl: stringValue(obj.ssh_url) ?? stringValue(obj.sshUrl),
    updatedAt: stringValue(obj.updated_at) ?? stringValue(obj.updatedAt),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function mergeRepoEntries(
  remote: PocketShellRepoEntry[],
  local: PocketShellRepoEntry[],
): PocketShellRepoBrowserEntry[] {
  const localByKey = new Map(local.map((entry) => [joinKey(entry), entry]));
  const seen = new Set<string>();
  const rows: PocketShellRepoBrowserEntry[] = [];

  for (const entry of remote) {
    const key = joinKey(entry);
    seen.add(key);
    const localMatch = localByKey.get(key);
    rows.push({
      fullName: key,
      name: entry.name,
      owner: entry.owner,
      cloned: localMatch?.local !== undefined,
      path: localMatch?.local?.path,
      defaultBranch: entry.remote?.defaultBranch,
      updatedAt: entry.remote?.updatedAt,
      remote: entry.remote,
    });
  }

  for (const entry of local) {
    const key = joinKey(entry);
    if (seen.has(key) || !entry.local) {
      continue;
    }
    seen.add(key);
    rows.push({
      fullName: key,
      name: entry.name,
      owner: entry.owner,
      cloned: true,
      path: entry.local.path,
      defaultBranch: entry.remote?.defaultBranch,
      updatedAt: entry.remote?.updatedAt,
      remote: entry.remote,
    });
  }

  return rows.sort((a, b) => {
    if (a.cloned !== b.cloned) {
      return a.cloned ? -1 : 1;
    }
    const updated = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
    return updated !== 0 ? updated : a.name.localeCompare(b.name);
  });
}

function joinKey(entry: PocketShellRepoEntry): string {
  if (entry.fullName) {
    return entry.fullName;
  }
  return entry.owner ? `${entry.owner}/${entry.name}` : entry.name;
}

export const __test = {
  parseRepoListJson,
  mergeRepoEntries,
};
