/**
 * Parser for Codex JSONL session logs.
 *
 * Expected format per line:
 *   { "type": "message", "role": "user"|"assistant"|"system", "content": "...", "ts": "..." }
 *   { "type": "file", "path": "...", "content": "...", "ts": "..." }
 *   { "type": "tool_use", "tool": "...", "input": {...}, "ts": "..." }
 *   { "type": "tool_result", "output": "...", "ts": "..." }
 *
 * Lines may also include a `cost` object with `input`/`output` token counts.
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
 * Parse an array of JSONL lines from a Codex session log.
 *
 * @param lines  Raw text lines (each should be a JSON object).
 * @returns A fully populated ConversationSession.
 */
export function parseCodexSession(lines: string[]): ConversationSession {
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
      continue;
    }

    if (!rec || typeof rec !== 'object') continue;

    const ts = parseTimestamp(rec.ts);
    if (ts > 0) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }

    switch (rec.type) {
      // Message with role and content at top level
      case 'message': {
        const role = rec.role;
        if (role !== 'user' && role !== 'assistant' && role !== 'system') break;

        const content = typeof rec.content === 'string' ? rec.content : '';

        // Token counts from cost field
        let tokenCount: number | undefined;
        if (rec.cost && typeof rec.cost.input === 'number') {
          const tokens = rec.cost.input + (rec.cost.output ?? 0);
          tokenCount = tokens;
          totalTokens += tokens;
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

      // Direct role types (alternative format)
      case 'user':
      case 'assistant':
      case 'system': {
        let content = '';

        // Content can be at top level or nested under "message"
        if (rec.message && typeof rec.message === 'object') {
          content = typeof rec.message.content === 'string' ? rec.message.content : '';
        } else if (typeof rec.content === 'string') {
          content = rec.content;
        }

        // Token counts from cost field
        let tokenCount: number | undefined;
        if (rec.cost && typeof rec.cost.input === 'number') {
          const tokens = rec.cost.input + (rec.cost.output ?? 0);
          tokenCount = tokens;
          totalTokens += tokens;
        }

        messages.push({
          id: nextId(),
          role: rec.type,
          content,
          timestamp: ts,
          tokenCount,
        });
        break;
      }

      // File writes — treat as assistant messages
      case 'file': {
        messages.push({
          id: nextId(),
          role: 'assistant',
          content: typeof rec.content === 'string' ? rec.content : '',
          timestamp: ts,
        });
        break;
      }

      // Tool use
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

      // Tool result — attach to most recent tool_use
      case 'tool_result': {
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

  return {
    id: `codex-${startedAt}`,
    agentType: 'codex',
    startedAt,
    endedAt,
    messageCount: messages.length,
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
    messages,
  };
}
