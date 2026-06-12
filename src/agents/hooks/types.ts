/**
 * Agent hooks management types for PocketShell Desktop.
 *
 * Defines the data structures for managing git hooks that trigger
 * agent actions on remote repositories via SSH.
 */

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

/** Supported agent engines. */
export type AgentType = 'claude' | 'codex' | 'opencode';

// ---------------------------------------------------------------------------
// Hook types
// ---------------------------------------------------------------------------

/** Git hook types that can be managed. */
export enum HookType {
  PreCommit = 'pre-commit',
  PostCommit = 'post-commit',
  PrePush = 'pre-push',
  PostMerge = 'post-merge',
  CommitMsg = 'commit-msg',
}

/** Status of a single hook installation. */
export type HookStatus = 'installed' | 'not-installed' | 'conflict' | 'error';

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/** A single agent hook associated with a git hook type. */
export interface AgentHook {
  /** Which git hook this targets. */
  type: HookType;
  /** Which agent engine the hook is configured for. */
  agentType: AgentType;
  /** Current installation status. */
  status: HookStatus;
  /** Path to the hook script on the remote filesystem. */
  scriptPath?: string;
  /** Whether the hook is enabled (will run). */
  isEnabled: boolean;
  /** Epoch timestamp (ms) when the hook was installed. */
  installedAt?: number;
}

/** Full hook configuration for a repository. */
export interface HookConfig {
  /** All hooks (installed and available) for the repo. */
  hooks: AgentHook[];
  /** Absolute path to the repository on the remote host. */
  repoPath: string;
}
