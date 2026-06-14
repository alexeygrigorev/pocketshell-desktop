/**
 * Jobs output parsers for PocketShell Desktop.
 *
 * Pure functions that parse `pocketshell jobs` command output into
 * structured AgentJob types. No side effects — easy to test with
 * fixture data.
 */

import type { AgentJob, AgentType, JobStatus } from './types';

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Map pocketshell status strings to JobStatus values.
 *
 * The fixture uses short status strings like "TODO", "WIP", "DONE",
 * as well as standard statuses like "running", "completed", etc.
 */
function mapStatus(raw: string): JobStatus {
  const normalized = raw.trim().toUpperCase();
  switch (normalized) {
    case 'RUNNING':
    case 'WIP':
      return 'running';
    case 'COMPLETED':
    case 'DONE':
      return 'completed';
    case 'FAILED':
    case 'ERROR':
      return 'failed';
    case 'CANCELLED':
    case 'CANCELED':
      return 'cancelled';
    case 'QUEUED':
    case 'TODO':
      return 'queued';
    default:
      return 'queued';
  }
}

/**
 * Parse an agent type string, defaulting to 'claude'.
 */
function parseAgentType(raw: string): AgentType {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'claude' || normalized === 'codex' || normalized === 'opencode') {
    return normalized;
  }
  return 'claude';
}

// ---------------------------------------------------------------------------
// Table parser — pocketshell jobs list
// ---------------------------------------------------------------------------

/**
 * Parse `pocketshell jobs list` output into an array of AgentJob.
 *
 * Supports two formats:
 *
 * 1. **Table format** (whitespace-separated columns):
 *    ```
 *    1  fix-auth-bug       TODO     Implement JWT token refresh        claude     2026-01-01 00:00
 *    2  add-tests          WIP      Add integration tests for login     codex      2026-01-01 00:01
 *    ```
 *    Columns: id, name, status, command, agentType, startedAt
 *
 * 2. **JSON format** (one JSON object per line or a JSON array):
 *    Each object has fields matching AgentJob properties.
 */
export function parseJobsList(output: string): AgentJob[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  // Try JSON format first
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return parseJsonJobs(trimmed);
  }

  // Fall back to table format
  return parseTableJobs(trimmed);
}

/**
 * Parse JSON-formatted jobs output.
 */
function parseJsonJobs(output: string): AgentJob[] {
  try {
    const parsed = JSON.parse(output);
    const items = Array.isArray(parsed) ? parsed : [parsed];

    return items.map((item: any) => ({
      id: String(item.id ?? ''),
      agentType: parseAgentType(item.agentType ?? item.agent_type ?? item.engine ?? 'claude'),
      sessionId: item.sessionId ?? item.session_id ?? undefined,
      status: typeof item.status === 'string'
        ? mapStatus(item.status)
        : 'queued',
      command: item.command ?? item.description ?? item.name ?? '',
      startedAt: item.startedAt ?? item.started_at ?? 0,
      completedAt: item.completedAt ?? item.completed_at ?? undefined,
      exitCode: item.exitCode ?? item.exit_code ?? undefined,
      cwd: item.cwd ?? undefined,
    }));
  } catch {
    // JSON parse failed — fall back to table parser
    return parseTableJobs(output);
  }
}

/**
 * Parse table-formatted jobs output.
 *
 * Expected columns (whitespace-separated):
 *   id  name  status  command...  agentType  startedAt (YYYY-MM-DD HH:MM)
 *
 * The command column may contain spaces. We parse from both ends
 * and treat everything between status and agentType as the command.
 */
function parseTableJobs(output: string): AgentJob[] {
  const lines = output.split('\n');
  const jobs: AgentJob[] = [];

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const tokens = trimmedLine.split(/\s+/);
    if (tokens.length < 6) continue;

    const id = tokens[0];
    const name = tokens[1];
    const rawStatus = tokens[2];
    const agentType = tokens[tokens.length - 3];

    // Date is last two tokens: YYYY-MM-DD HH:MM
    const dateStr = `${tokens[tokens.length - 2]} ${tokens[tokens.length - 1]}`;
    const startedAt = parseDateTime(dateStr);

    // Everything between status and agentType is the command/description
    const statusEndIdx = 3; // after id, name, status
    const agentTypeIdx = tokens.length - 3;
    const commandTokens = tokens.slice(statusEndIdx, agentTypeIdx);
    const command = commandTokens.join(' ') || name;

    jobs.push({
      id,
      agentType: parseAgentType(agentType),
      status: mapStatus(rawStatus),
      command,
      startedAt,
    });
  }

  return jobs;
}

/**
 * Parse a date-time string like "2026-01-01 00:00" into a Unix timestamp (ms).
 */
function parseDateTime(s: string): number {
  const ms = Date.parse(s.replace(' ', 'T') + ':00Z');
  return Number.isNaN(ms) ? 0 : ms;
}
