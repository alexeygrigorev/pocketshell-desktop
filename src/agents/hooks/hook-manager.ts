/**
 * Hook manager for PocketShell Desktop.
 *
 * Manages git hooks that trigger agent actions on remote repositories.
 * Delegates to the `pocketshell hooks` CLI over SSH exec.
 */

import type { SshConnection, ExecResult } from '../../ssh/connection/ssh-client';
import { HookType, type AgentType, type HookConfig, type AgentHook, type HookStatus } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quote a shell argument with single quotes. */
function quote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Parse the text output of `pocketshell hooks status` into per-agent status.
 *
 * Expected output format (one line per agent):
 *   claude: installed
 *   codex: not installed
 *   opencode: error
 */
function parseStatusOutput(output: string): Map<string, HookStatus> {
  const result = new Map<string, HookStatus>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const agent = trimmed.slice(0, colonIdx).trim();
    const rawStatus = trimmed.slice(colonIdx + 1).trim();
    const status = normalizeStatus(rawStatus);
    result.set(agent, status);
  }
  return result;
}

/** Map free-form status text to a HookStatus. */
function normalizeStatus(raw: string): HookStatus {
  const lower = raw.toLowerCase();
  if (lower === 'installed') return 'installed';
  if (lower === 'not installed' || lower === 'not-installed') return 'not-installed';
  if (lower === 'conflict') return 'conflict';
  return 'error';
}

// ---------------------------------------------------------------------------
// HookManager
// ---------------------------------------------------------------------------

export class HookManager {
  private connection: SshConnection;

  constructor(connection: SshConnection) {
    this.connection = connection;
  }

  /**
   * Check the hook installation status for a repository.
   *
   * Runs `pocketshell hooks status` in the repo directory and
   * returns a HookConfig with one AgentHook per (hookType, agentType) pair.
   */
  async status(repoPath: string): Promise<HookConfig> {
    const cmd = `cd ${quote(repoPath)} && pocketshell hooks status`;
    const result = await this.connection.exec(cmd);

    if (result.exitCode !== 0) {
      // If the repo doesn't exist or pocketshell is unavailable, return
      // an empty config with all hooks in 'error' state.
      return {
        hooks: this.allHooksError(),
        repoPath,
      };
    }

    const agentStatuses = parseStatusOutput(result.stdout);
    const hooks: AgentHook[] = [];

    for (const hookType of Object.values(HookType)) {
      for (const [agent, status] of agentStatuses) {
        const isInstalled = status === 'installed';
        hooks.push({
          type: hookType,
          agentType: agent as AgentType,
          status,
          scriptPath: isInstalled ? this.hookScriptPath(repoPath, hookType) : undefined,
          isEnabled: isInstalled,
          installedAt: isInstalled ? Date.now() : undefined,
        });
      }
    }

    return { hooks, repoPath };
  }

  /**
   * Install a hook for a given agent type in a repository.
   *
   * Runs `pocketshell hooks install <agentType>` in the repo directory.
   */
  async install(repoPath: string, hookType: HookType, agentType: AgentType): Promise<void> {
    const cmd = `cd ${quote(repoPath)} && pocketshell hooks install ${agentType}`;
    const result = await this.connection.exec(cmd);

    if (result.exitCode !== 0) {
      throw new Error(
        `pocketshell hooks install failed for ${agentType} (${hookType}): ${result.stderr}`,
      );
    }
  }

  /**
   * Uninstall a hook from a repository.
   *
   * Runs `pocketshell hooks uninstall` in the repo directory.
   */
  async uninstall(repoPath: string, hookType: HookType): Promise<void> {
    const cmd = `cd ${quote(repoPath)} && pocketshell hooks uninstall`;
    const result = await this.connection.exec(cmd);

    if (result.exitCode !== 0) {
      throw new Error(
        `pocketshell hooks uninstall failed (${hookType}): ${result.stderr}`,
      );
    }
  }

  /**
   * Enable a previously installed hook.
   *
   * Runs `pocketshell hooks install <agentType>` to re-enable.
   */
  async enable(repoPath: string, hookType: HookType): Promise<void> {
    const cmd = `cd ${quote(repoPath)} && pocketshell hooks install --enable`;
    const result = await this.connection.exec(cmd);

    if (result.exitCode !== 0) {
      throw new Error(
        `pocketshell hooks enable failed (${hookType}): ${result.stderr}`,
      );
    }
  }

  /**
   * Disable a hook without uninstalling it.
   *
   * Runs `pocketshell hooks install --disable` to disable.
   */
  async disable(repoPath: string, hookType: HookType): Promise<void> {
    const cmd = `cd ${quote(repoPath)} && pocketshell hooks install --disable`;
    const result = await this.connection.exec(cmd);

    if (result.exitCode !== 0) {
      throw new Error(
        `pocketshell hooks disable failed (${hookType}): ${result.stderr}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Build the expected path to a hook script in a git repo. */
  private hookScriptPath(repoPath: string, hookType: HookType): string {
    return `${repoPath}/.git/hooks/${hookType}`;
  }

  /** Return AgentHook entries for all combinations in 'error' state. */
  private allHooksError(): AgentHook[] {
    const agents: AgentType[] = ['claude', 'codex', 'opencode'];
    const hooks: AgentHook[] = [];
    for (const hookType of Object.values(HookType)) {
      for (const agentType of agents) {
        hooks.push({
          type: hookType,
          agentType,
          status: 'error',
          isEnabled: false,
        });
      }
    }
    return hooks;
  }
}
