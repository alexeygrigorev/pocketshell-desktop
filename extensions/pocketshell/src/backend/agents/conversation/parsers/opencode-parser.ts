/**
 * Parser for OpenCode session logs.
 *
 * Expected format per line:
 *   { "type": "user", "content": "...", "ts": "...", "session": "..." }
 *   { "type": "assistant", "content": "...", "ts": "...", "session": "..." }
 *   { "type": "tool_use", "tool": "...", "input": {...}, "ts": "...", "session": "..." }
 *   { "type": "tool_result", "output": "...", "ts": "...", "session": "..." }
 *
 * Lines that are not valid JSON or lack a recognized `type` are skipped.
 */

import {
  ConversationMessage,
  ConversationSession,
} from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function nextId(): string {
  return `msg-${++idCounter}`;
}

/** Reset the id counter (useful for deterministic tests). */
export function resetIdCounter(): void {
  idCounter = 0;
}

function parseTimestamp(ts: unknown): number {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const d = Date.parse(ts);
    return Number.isNaN(d) ? 0 : d;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse an array of JSONL lines from an OpenCode session log.
 *
 * @param lines  Raw text lines (each should be a JSON object).
 * @returns A fully populated ConversationSession.
 */
export function parseOpenCodeSession(lines: string[]): ConversationSession {
  const messages: ConversationMessage[] = [];
  let minTs = Infinity;
  let maxTs = 0;
  let sessionName: string | undefined;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let rec: any;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!rec || typeof rec !== 'object') continue;

    const ts = parseTimestamp(rec.ts);
    if (ts > 0) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }

    // Capture session name if present
    if (rec.session && !sessionName) {
      sessionName = rec.session;
    }

    switch (rec.type) {
      case 'user': {
        messages.push({
          id: nextId(),
          role: 'user',
          content: typeof rec.content === 'string' ? rec.content : '',
          timestamp: ts,
        });
        break;
      }

      case 'assistant': {
        messages.push({
          id: nextId(),
          role: 'assistant',
          content: typeof rec.content === 'string' ? rec.content : '',
          timestamp: ts,
        });
        break;
      }

      case 'tool_use': {
        messages.push({
          id: nextId(),
          role: 'tool',
          content: `Tool: ${rec.tool ?? 'unknown'}`,
          timestamp: ts,
          toolName: rec.tool,
          toolInput: rec.input,
        });
        break;
      }

      case 'tool_result': {
        // Attach output to the most recent tool_use that has no output yet
        const lastToolUse = [...messages]
          .reverse()
          .find(m => m.role === 'tool' && m.toolOutput === undefined);

        if (lastToolUse) {
          lastToolUse.toolOutput = typeof rec.output === 'string' ? rec.output : JSON.stringify(rec.output);
        } else {
          messages.push({
            id: nextId(),
            role: 'tool',
            content: typeof rec.output === 'string' ? rec.output : JSON.stringify(rec.output),
            timestamp: ts,
            toolOutput: typeof rec.output === 'string' ? rec.output : JSON.stringify(rec.output),
          });
        }
        break;
      }

      default:
        break;
    }
  }

  const startedAt = minTs === Infinity ? 0 : minTs;
  const endedAt = maxTs > 0 ? maxTs : undefined;
  const id = sessionName ?? `opencode-${startedAt}`;

  return {
    id,
    agentType: 'opencode',
    startedAt,
    endedAt,
    messageCount: messages.length,
    messages,
  };
}
