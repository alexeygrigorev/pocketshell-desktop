/**
 * Job types for PocketShell Desktop.
 *
 * Data types used by JobsClient and the jobs output parser.
 */

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

/** Supported agent engines. */
export type AgentType = 'claude' | 'codex' | 'opencode';

// ---------------------------------------------------------------------------
// Job status
// ---------------------------------------------------------------------------

/** Lifecycle status of an agent job. */
export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'queued';

// ---------------------------------------------------------------------------
// Agent job
// ---------------------------------------------------------------------------

/** A background job managed by the pocketshell agent. */
export interface AgentJob {
  id: string;
  agentType: AgentType;
  sessionId?: string;
  status: JobStatus;
  /** Description of what the job is doing. */
  command: string;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  cwd?: string;
}
