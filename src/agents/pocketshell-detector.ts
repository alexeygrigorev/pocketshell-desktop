/**
 * PocketShell-based agent detector.
 *
 * Uses the `pocketshell agent-log` subcommand (or similar) to detect agents.
 * Falls back to manual detection via AgentDetector if pocketshell is not
 * available on the remote host.
 */

import type { SshConnection } from '../ssh/connection/ssh-client';
import { AgentType, DetectedAgent, AGENT_METADATA } from './types';
import { AgentDetector } from './agent-detector';

/**
 * Result shape returned by `pocketshell agent-log --json --engine <engine>`.
 * Minimal — we only need the engine name to confirm detection.
 */
interface PocketshellAgentLogResult {
  count: number;
  engine: string;
  path: string;
  session?: string;
}

/**
 * Detects agents using the pocketshell utility on the remote host.
 * Falls back to manual `which`-based detection when pocketshell is absent.
 */
export class PocketshellAgentDetector {
  private fallbackDetector: AgentDetector;

  constructor(private connection: SshConnection) {
    this.fallbackDetector = new AgentDetector(connection);
  }

  /**
   * Detect agents using pocketshell.
   *
   * Strategy:
   * 1. Check if `pocketshell` is available on the remote host.
   * 2. If available, run `pocketshell agent-log --json --engine <engine>`
   *    for each known engine to confirm presence.
   * 3. If pocketshell is not available, fall back to AgentDetector.
   */
  async detect(): Promise<DetectedAgent[]> {
    const pocketshellAvailable = await this.isPocketshellAvailable();

    if (!pocketshellAvailable) {
      return this.fallbackDetector.detectAll();
    }

    const now = Date.now();
    const results: DetectedAgent[] = [];

    const engines: Exclude<AgentType, AgentType.Unknown>[] = [
      AgentType.Claude,
      AgentType.Codex,
      AgentType.OpenCode,
    ];

    // Probe each engine via pocketshell in parallel
    const probes = await Promise.all(
      engines.map(async (type): Promise<DetectedAgent> => {
        const meta = AGENT_METADATA[type];

        try {
          const result = await this.connection.exec(
            `pocketshell agent-log --json --engine ${meta.binary}`,
            10_000,
          );

          if (result.exitCode === 0 && result.stdout.trim()) {
            const parsed = this.parseAgentLogJson(result.stdout);
            if (parsed) {
              return {
                type,
                name: meta.name,
                version: undefined, // agent-log doesn't provide version
                binaryPath: parsed.path,
                isInstalled: true,
                detectedAt: now,
              };
            }
          }
        } catch {
          // Fall through to "not installed"
        }

        return {
          type,
          name: meta.name,
          isInstalled: false,
          detectedAt: now,
        };
      }),
    );

    results.push(...probes);

    // For installed agents, try to enrich with version + binary path
    // via the fallback detector's per-agent logic
    const enriched = await Promise.all(
      results.map(async (agent): Promise<DetectedAgent> => {
        if (!agent.isInstalled) return agent;

        // Try to get version via direct binary probe
        try {
          const meta = AGENT_METADATA[agent.type];
          const versionResult = await this.connection.exec(
            `${meta.binary} --version 2>/dev/null`,
            10_000,
          );
          if (versionResult.exitCode === 0 && versionResult.stdout.trim()) {
            const versionMatch = versionResult.stdout.trim().match(
              /\bv?(\d+\.\d+(?:\.\d+)?(?:[-.]\w+)*)\b/i,
            );
            if (versionMatch) {
              agent.version = versionMatch[1];
            }
          }

          // Also get the binary path via `which`
          const whichResult = await this.connection.exec(
            `which ${meta.binary} 2>/dev/null`,
            10_000,
          );
          if (whichResult.exitCode === 0 && whichResult.stdout.trim()) {
            agent.binaryPath = whichResult.stdout.trim();
          }
        } catch {
          // Best-effort enrichment; keep the agent as-is
        }

        return agent;
      }),
    );

    return enriched;
  }

  /** Check whether the pocketshell utility is available on the remote host. */
  private async isPocketshellAvailable(): Promise<boolean> {
    try {
      const result = await this.connection.exec(
        'which pocketshell 2>/dev/null',
        5_000,
      );
      return result.exitCode === 0 && !!result.stdout.trim();
    } catch {
      return false;
    }
  }

  /** Try to parse pocketshell agent-log JSON output. */
  private parseAgentLogJson(
    output: string,
  ): PocketshellAgentLogResult | null {
    try {
      const parsed = JSON.parse(output.trim());
      if (parsed && typeof parsed.engine === 'string') {
        return parsed as PocketshellAgentLogResult;
      }
    } catch {
      // Not valid JSON
    }
    return null;
  }
}
