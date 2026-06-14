/**
 * Agent detector — discovers AI coding agents on a remote SSH host.
 *
 * For each known agent (Claude, Codex, OpenCode), runs `which <binary>`
 * to find the binary path and `<binary> --version` to extract the version.
 */

import type { SshConnection, ExecResult } from '../ssh/connection/ssh-client';
import { AgentType, DetectedAgent, AGENT_METADATA } from './types';

/** Ordered list of agent types to probe during detectAll(). */
const ALL_AGENT_TYPES: Exclude<AgentType, AgentType.Unknown>[] = [
  AgentType.Claude,
  AgentType.Codex,
  AgentType.OpenCode,
];

/**
 * Detects AI coding agents on a remote SSH host.
 */
export class AgentDetector {
  constructor(private connection: SshConnection) {}

  /**
   * Detect all known agents on the remote host.
   * Runs detection in parallel for speed.
   */
  async detectAll(): Promise<DetectedAgent[]> {
    const results = await Promise.all(
      ALL_AGENT_TYPES.map((type) => this.detectOne(type)),
    );
    // Filter out nulls (shouldn't happen, but be safe)
    return results.filter((r): r is DetectedAgent => r !== null);
  }

  /**
   * Detect a single agent type on the remote host.
   * Returns a DetectedAgent with `isInstalled: false` if the agent
   * binary is not found.
   */
  async detectOne(type: AgentType): Promise<DetectedAgent | null> {
    if (type === AgentType.Unknown) {
      return null;
    }

    const meta = AGENT_METADATA[type];
    const now = Date.now();

    // Step 1: which <binary>
    const whichResult = await this.runCommand(`which ${meta.binary} 2>/dev/null`);

    if (whichResult.exitCode !== 0 || !whichResult.stdout.trim()) {
      return {
        type,
        name: meta.name,
        isInstalled: false,
        detectedAt: now,
      };
    }

    const binaryPath = whichResult.stdout.trim();

    // Step 2: <binary> --version
    const versionResult = await this.runCommand(
      `${meta.binary} --version 2>/dev/null`,
    );
    const version = parseVersion(versionResult);

    return {
      type,
      name: meta.name,
      version,
      binaryPath,
      isInstalled: true,
      detectedAt: now,
    };
  }

  /** Execute a command on the remote host, returning a default on error. */
  private async runCommand(command: string): Promise<ExecResult> {
    try {
      return await this.connection.exec(command, 10_000);
    } catch {
      return { stdout: '', stderr: '', exitCode: 1 };
    }
  }
}

/**
 * Try to extract a semver-like version string from command output.
 *
 * Looks for patterns like "1.2.3", "v1.2.3", "version 1.2.3", etc.
 * Returns the first match found, or undefined.
 */
export function parseVersion(result: ExecResult): string | undefined {
  const output = (result.stdout || '').trim();
  if (!output) return undefined;

  // Common patterns:
  //   "Claude Code 1.0.3"
  //   "codex 0.1.0"
  //   "opencode v0.2.1-dev"
  //   "1.2.3"
  //   "version: 1.2.3"
  const match = output.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-.]\w+)*)\b/i);
  return match ? match[1] : undefined;
}
