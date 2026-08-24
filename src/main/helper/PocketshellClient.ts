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
  parseSessionEnrichment,
  mergeSessionEnrichment,
  SESSION_ENRICHMENT_COMMAND,
  type UsageRow,
  type ResumableSession,
  type AgentLogEnvelope,
  type SessionEnrichment,
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
    // Primary + companion in ONE round-trip. `pocketshell sessions list` gives
    // names and creation times; the tmux probe gives the cwd, attached flag,
    // and recorded agent kind that the three-column table simply does not
    // carry. They are independent execs on the same connection, so issuing
    // them together costs one RTT rather than two.
    const [helper, enrichment] = await Promise.all([
      this.ssh.exec(connectionId, pathAwareCommand(`pocketshell sessions list --by ${sortBy}`)),
      this.sessionEnrichment(connectionId),
    ]);
    if (helper.exitCode === 0) {
      const parsed = parseSessionsList(helper.stdout);
      if (parsed.length > 0 || /IDX\s+SESSION/.test(helper.stdout)) {
        return mergeSessionEnrichment(parsed, enrichment);
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
      // Still merged: the fallback's `session_path` is the *session's* cwd,
      // and the probe's active-pane cwd is the better answer when both exist.
      return mergeSessionEnrichment(parseTmuxListSessionsFallback(tmux.stdout), enrichment);
    }
    // "no server running" / "not found" -> empty (not an error).
    return [];
  }

  /**
   * Run the companion tmux probe for cwd / attached / agent kind.
   *
   * Degrades to an empty map on ANY failure — no tmux, no server running, a
   * tmux too old to expand `#{@ps_agent_kind}`. Sessions must still list when
   * this probe comes back empty; only the folder-grouping metadata is lost.
   */
  private async sessionEnrichment(connectionId: string): Promise<Map<string, SessionEnrichment>> {
    const res = await this.ssh.exec(connectionId, pathAwareCommand(SESSION_ENRICHMENT_COMMAND));
    if (res.exitCode !== 0) return new Map();
    return parseSessionEnrichment(res.stdout);
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

  /**
   * Agent config-dir profiles (`pocketshell profiles list --json`).
   *
   * 0.4.44 emits a `{"profiles": [...]}` ENVELOPE, not the bare array the
   * v0.4.8 contract documented — so the old `Array.isArray` guard silently
   * returned `[]` for every profile on a current host. Both shapes are
   * accepted so the call keeps working on either helper version.
   */
  async listProfiles(connectionId: string): Promise<unknown[]> {
    const res = await this.ssh.exec(connectionId, pathAwareCommand('pocketshell profiles list --json'));
    if (res.exitCode !== 0) return [];
    try {
      const parsed: unknown = JSON.parse(res.stdout.trim());
      // Array.isArray narrows `unknown` to `any[]`, so each branch is cast
      // back to `unknown[]` rather than leaking `any` to the caller.
      if (Array.isArray(parsed)) return parsed as unknown[];
      const envelope = (parsed as { profiles?: unknown } | null)?.profiles;
      return Array.isArray(envelope) ? (envelope as unknown[]) : [];
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
      // Typed `unknown`, matching listProfiles above: an untyped JSON.parse
      // leaks `any` through the return and defeats checking downstream.
      const parsed: unknown = JSON.parse(res.stdout.trim());
      return Array.isArray(parsed) ? (parsed as unknown[]) : [];
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
