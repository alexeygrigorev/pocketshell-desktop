/**
 * Parser for Claude NDJSON session logs.
 *
 * Supports two formats:
 *
 * Format A — direct role as type (Claude CLI output):
 *   { "type": "user", "message": { "role": "user", "content": "..." }, "ts": "..." }
 *   { "type": "assistant", "message": { "role": "assistant", "content": "..." }, "ts": "..." }
 *
 * Format B — explicit message type:
 *   { "type": "message", "role": "user"|"assistant"|"system", "content": "...", "ts": "..." }
 *
 * Common types:
 *   { "type": "tool_use", "tool": "...", "input": {...}, "ts": "..." }
 *   { "type": "tool_result", "output": "...", "ts": "..." }
 *   { "type": "file", "path": "...", "content": "...", "ts": "..." }
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

/** Generate a unique message id within this parse invocation. */
function nextId(): string {
  return `msg-${++idCounter}`;
}

/** Reset the id counter (useful for deterministic tests). */
export function resetIdCounter(): void {
  idCounter = 0;
}

/** Parse an ISO timestamp string to unix ms. Returns 0 on failure. */
function parseTimestamp(ts: unknown): number {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const d = Date.parse(ts);
    return Number.isNaN(d) ? 0 : d;
  }
  return 0;
}

/** Extract a string field from a JSON object, defaulting to empty. */
function str(obj: unknown, key: string): string {
  if (obj && typeof obj === 'object' && key in obj) {
    const v = (obj as any)[key];
    return typeof v === 'string' ? v : '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse an array of NDJSON lines from a Claude session log.
 *
 * @param lines  Raw text lines (each should be a JSON object).
 * @returns A fully populated ConversationSession.
 */
export function parseClaudeSession(lines: string[]): ConversationSession {
  const messages: ConversationMessage[] = [];
  let minTs = Infinity;
  let maxTs = 0;
  let totalTokens = 0;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let rec: any;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      // Skip malformed lines
      continue;
    }

    if (!rec || typeof rec !== 'object' || !rec.type) continue;

    const ts = parseTimestamp(rec.ts);
    if (ts > 0) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }

    switch (rec.type) {
      // Format A: type is the role directly, content is in nested "message"
      case 'user':
      case 'assistant': {
        // Role comes from nested message or from type itself
        let role: 'user' | 'assistant' = rec.type;
        let content = '';

        if (rec.message && typeof rec.message === 'object') {
          content = typeof rec.message.content === 'string' ? rec.message.content : '';
        } else if (typeof rec.content === 'string') {
          content = rec.content;
        }

        // Accumulate token counts if present
        let tokenCount: number | undefined;
        if (rec.cost && typeof rec.cost.input === 'number') {
          tokenCount = rec.cost.input + (rec.cost.output ?? 0);
          totalTokens += tokenCount;
        }

        messages.push({
          id: nextId(),
          role,
          content,
          timestamp: ts,
          tokenCount,
        });
        break;
      }

      // Format B: explicit "message" type with role field
      case 'message': {
        const role = rec.role;
        if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;

        const content = typeof rec.content === 'string' ? rec.content : '';

        // Accumulate token counts if present
        let tokenCount: number | undefined;
        if (rec.cost && typeof rec.cost.input === 'number') {
          tokenCount = rec.cost.input + (rec.cost.output ?? 0);
          totalTokens += tokenCount;
        }

        messages.push({
          id: nextId(),
          role,
          content,
          timestamp: ts,
          tokenCount,
        });
        break;
      }

      case 'system': {
        let content = '';
        if (rec.message && typeof rec.message === 'object') {
          content = typeof rec.message.content === 'string' ? rec.message.content : '';
        } else if (typeof rec.content === 'string') {
          content = rec.content;
        }

        messages.push({
          id: nextId(),
          role: 'system',
          content,
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
        // Attach output to the most recent tool_use message if possible
        const lastToolUse = [...messages]
          .reverse()
          .find(m => m.role === 'tool' && m.toolOutput === undefined);

        if (lastToolUse) {
          lastToolUse.toolOutput = typeof rec.output === 'string' ? rec.output : JSON.stringify(rec.output);
        } else {
          // Standalone tool result — emit as a tool message
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

      case 'file': {
        // Treat file writes as assistant messages with context
        messages.push({
          id: nextId(),
          role: 'assistant',
          content: rec.content ?? '',
          timestamp: ts,
        });
        break;
      }

      default:
        // Unknown type — skip
        break;
    }
  }

  const startedAt = minTs === Infinity ? 0 : minTs;
  const endedAt = maxTs > 0 ? maxTs : undefined;

  return {
    id: `claude-${startedAt}`,
    agentType: 'claude',
    startedAt,
    endedAt,
    messageCount: messages.length,
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
    messages,
  };
}
