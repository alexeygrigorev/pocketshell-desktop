/**
 * Jobs module for PocketShell Desktop.
 *
 * Provides job management for agent background tasks via the
 * pocketshell jobs subcommand over SSH.
 */

export { JobsClient } from './jobs-client';
export { parseJobsList } from './jobs-parser';
export type {
  AgentType,
  JobStatus,
  AgentJob,
} from './types';
