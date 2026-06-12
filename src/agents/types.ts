/**
 * Agent auto-detection types for PocketShell Desktop.
 *
 * Represents AI coding agents (Claude, Codex, OpenCode) that may be
 * installed on a remote SSH host.
 */

/** Supported AI coding agent types. */
export enum AgentType {
  Claude = 'claude',
  Codex = 'codex',
  OpenCode = 'opencode',
  Unknown = 'unknown',
}

/** A detected (or absent) agent on a remote host. */
export interface DetectedAgent {
  /** Which agent this is. */
  type: AgentType;

  /** Human-readable display name (e.g. "Claude Code"). */
  name: string;

  /** Parsed version string, if available. */
  version?: string;

  /** Absolute path to the agent binary on the remote host. */
  binaryPath?: string;

  /** Whether the agent binary was found on the host. */
  isInstalled: boolean;

  /** Unix timestamp (ms) when detection was performed. */
  detectedAt: number;
}

/** Maps AgentType to its display name and binary name. */
export const AGENT_METADATA: Record<
  Exclude<AgentType, AgentType.Unknown>,
  { name: string; binary: string }
> = {
  [AgentType.Claude]: { name: 'Claude Code', binary: 'claude' },
  [AgentType.Codex]: { name: 'Codex', binary: 'codex' },
  [AgentType.OpenCode]: { name: 'OpenCode', binary: 'opencode' },
};
