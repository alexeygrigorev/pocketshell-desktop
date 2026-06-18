/**
 * Client for the server-side `pocketshell` helper. Runs subcommands over an
 * existing SSH connection (via SshService.exec) and parses their output.
 *
 * Mirrors the Android `HostTmuxSessionsGateway` / `PocketshellClient`
 * pattern: try the helper first, fall back to raw tmux when the helper is
 * absent (or returns non-zero).
 */

import type { SshService } from '../ssh/SshService.js';
import type { SessionSummary } from '../../shared/types.js';
import {
  parseSessionsList,
  parseTmuxListSessionsFallback,
  parseUsageNdjson,
  parseResumableTable,
  parseAgentLogJson,
  type UsageRow,
  type ResumableSession,
  type AgentLogEnvelope,
} from './parsers.js';
import { pathAwareCommand } from './bootstrap.js';

/**
 * One-shot helper invocations over a connected host. Stateless: pass the
 * SshService + connectionId into each call.
 */
export class PocketshellClient {
  constructor(private readonly ssh: SshService) {}

  /**
   * List live tmux sessions. Prefers `pocketshell sessions list`, falls back
   * to `tmux list-sessions` when the helper is absent. Returns [] when no
   * tmux server is running (the canonical "empty" state, not an error).
   */
  async listSessions(connectionId: string, sortBy: 'activity' | 'created' = 'activity'): Promise<SessionSummary[]> {
    // Primary: the helper.
    const helper = await this.ssh.exec(
      connectionId,
      pathAwareCommand(`pocketshell sessions list --by ${sortBy}`),
    );
    if (helper.exitCode === 0) {
      const parsed = parseSessionsList(helper.stdout);
      if (parsed.length > 0 || /IDX\s+SESSION/.test(helper.stdout)) {
        return parsed;
      }
    }
    // Fallback: raw tmux with the same `::` shape the Android gateway uses.
    const tmux = await this.ssh.exec(
      connectionId,
      pathAwareCommand(
        "tmux list-sessions -F '#{session_name}::#{session_created}::#{session_activity}::#{session_attached}::#{session_path}'",
      ),
    );
    if (tmux.exitCode === 0) {
      return parseTmuxListSessionsFallback(tmux.stdout);
    }
    // "no server running" / "not found" -> empty (not an error).
    return [];
  }

  /** Create a new detached tmux session via `pocketshell sessions create`. */
  async createSession(connectionId: string, name: string, cwd?: string): Promise<boolean> {
    const cwdArg = cwd ? ` -c '${cwd.replace(/'/g, "'\\''")}'` : '';
    const res = await this.ssh.exec(
      connectionId,
      pathAwareCommand(`pocketshell sessions create '${name.replace(/'/g, "'\\''")}'${cwdArg}`),
    );
    return res.exitCode === 0;
  }

  /** Provider quota via `pocketshell usage --json`. Returns [] if unavailable. */
  async usage(connectionId: string): Promise<UsageRow[]> {
    const res = await this.ssh.exec(connectionId, pathAwareCommand('pocketshell usage --json'));
    if (res.exitCode !== 0) return [];
    return parseUsageNdjson(res.stdout);
  }

  /** Resumable AI-CLI conversations. Returns [] if the helper is absent. */
  async listResumable(connectionId: string, allProjects = true): Promise<ResumableSession[]> {
    const flag = allProjects ? ' --all' : '';
    const res = await this.ssh.exec(
      connectionId,
      pathAwareCommand(`pocketshell sessions resumable${flag}`),
    );
    if (res.exitCode !== 0) return [];
    return parseResumableTable(res.stdout);
  }

  /** Read a per-engine agent conversation log (`--json` envelope). */
  async agentLog(
    connectionId: string,
    engine: 'claude' | 'codex' | 'opencode',
    session: string,
    cwd?: string,
  ): Promise<AgentLogEnvelope | null> {
    const cwdArg = cwd ? ` --cwd '${cwd.replace(/'/g, "'\\''")}'` : '';
    const res = await this.ssh.exec(
      connectionId,
      pathAwareCommand(
        `pocketshell agent-log --engine ${engine} --session '${session.replace(/'/g, "'\\''")}'${cwdArg} --json`,
      ),
    );
    if (res.exitCode !== 0) return null; // 66 = not found
    return parseAgentLogJson(res.stdout);
  }

  /** Agent config-dir profiles (`pocketshell profiles list --json`). */
  async listProfiles(connectionId: string): Promise<unknown[]> {
    const res = await this.ssh.exec(connectionId, pathAwareCommand('pocketshell profiles list --json'));
    if (res.exitCode !== 0) return [];
    try {
      const parsed = JSON.parse(res.stdout.trim());
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Env keys for a folder (`pocketshell env list --dir D --json`). */
  async envList(connectionId: string, dir: string): Promise<unknown[]> {
    const res = await this.ssh.exec(
      connectionId,
      pathAwareCommand(`pocketshell env list --dir '${dir.replace(/'/g, "'\\''")}' --json`),
    );
    if (res.exitCode !== 0) return [];
    try {
      const parsed = JSON.parse(res.stdout.trim());
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Env values for a folder (`pocketshell env get --dir D --json`). */
  async envGet(connectionId: string, dir: string): Promise<Record<string, string>> {
    const res = await this.ssh.exec(
      connectionId,
      pathAwareCommand(`pocketshell env get --dir '${dir.replace(/'/g, "'\\''")}' --json`),
    );
    if (res.exitCode !== 0) return {};
    try {
      return JSON.parse(res.stdout.trim()) as Record<string, string>;
    } catch {
      return {};
    }
  }
}
