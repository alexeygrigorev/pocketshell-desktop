/**
 * Parser dispatcher — selects the correct parser based on agent type.
 */

import { AgentType, ConversationSession } from '../types';
import { parseClaudeSession } from './claude-parser';
import { parseCodexSession } from './codex-parser';
import { parseOpenCodeSession } from './opencode-parser';

/**
 * Parse a session log using the appropriate parser for the given agent type.
 *
 * @param agentType  Which agent produced this log.
 * @param content    Raw file content (NDJSON — newline-delimited JSON).
 * @returns A fully populated ConversationSession.
 */
export function parseSession(agentType: AgentType, content: string): ConversationSession {
  const lines = content.split('\n');

  switch (agentType) {
    case 'claude':
      return parseClaudeSession(lines);
    case 'codex':
      return parseCodexSession(lines);
    case 'opencode':
      return parseOpenCodeSession(lines);
    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }
}

// Re-export individual parsers for direct use
export { parseClaudeSession } from './claude-parser';
export { parseCodexSession } from './codex-parser';
export { parseOpenCodeSession } from './opencode-parser';
