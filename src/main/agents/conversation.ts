/**
 * Pure renderers that normalize per-engine agent JSONL into a unified
 * conversation message list for the ConversationView.
 *
 * Three engines, three on-disk shapes (matching the `pocketshell agent-log`
 * contract and the Android AgentConversationRepository):
 *
 *   - claude:  one JSON obj/line; {type:'user'|'assistant', message:{role, content: str | [{type:'text'|'tool_use', ...}]}}
 *   - codex:   {type:'session_meta'|'event_msg'|'response_item', payload:{...}}; user text via event_msg/user_message, assistant via response_item/message
 *   - opencode:{role:'user'|'assistant', content: str}
 *
 * Each renderer returns {@link ConversationMessage}[] in chronological order.
 * Tool calls are preserved as collapsible blocks; only human/assistant text
 * is rendered as prose.
 */

export type ConversationRole = 'user' | 'assistant';

export interface ConversationBlock {
  type: 'text' | 'tool_call' | 'tool_result';
  /** For text: the prose. For tool_call: a short label (name + truncated input). */
  text: string;
  /** For tool_call/tool_result: the raw JSON of the input/output, for expansion. */
  detail?: string;
}

export interface ConversationMessage {
  role: ConversationRole;
  blocks: ConversationBlock[];
}

/** Render raw JSONL lines (from `pocketshell agent-log`) into messages. */
export function renderConversation(
  engine: 'claude' | 'codex' | 'opencode',
  lines: string[],
): ConversationMessage[] {
  if (engine === 'claude') return renderClaude(lines);
  if (engine === 'codex') return renderCodex(lines);
  return renderOpencode(lines);
}

// --- claude ---------------------------------------------------------------

function renderClaude(lines: string[]): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  for (const line of lines) {
    const obj = parseJson(line);
    if (!obj || typeof obj !== 'object') continue;
    const message = (obj as { message?: unknown }).message;
    if (!message || typeof message !== 'object') continue;
    const role = (message as { role?: string }).role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = (message as { content?: unknown }).content;
    const blocks = claudeBlocks(content);
    if (blocks.length > 0) out.push({ role, blocks });
  }
  return out;
}

function claudeBlocks(content: unknown): ConversationBlock[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ConversationBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: string; name?: string; input?: unknown };
    if (p.type === 'text' && typeof p.text === 'string') {
      blocks.push({ type: 'text', text: p.text });
    } else if (p.type === 'tool_use') {
      blocks.push({
        type: 'tool_call',
        text: p.name ?? 'tool',
        detail: safeStringify(p.input),
      });
    } else if (p.type === 'tool_result') {
      blocks.push({
        type: 'tool_result',
        text: 'result',
        detail: safeStringify((part as { content?: unknown }).content),
      });
    }
  }
  return blocks;
}

// --- codex ----------------------------------------------------------------

function renderCodex(lines: string[]): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  for (const line of lines) {
    const obj = parseJson(line);
    if (!obj || typeof obj !== 'object') continue;
    const type = (obj as { type?: string }).type;
    const payload = (obj as { payload?: unknown }).payload;
    if (!payload || typeof payload !== 'object') continue;
    const p = payload as {
      type?: string;
      role?: string;
      message?: string;
      content?: unknown;
      name?: string;
      arguments?: string;
      call_id?: string;
    };

    if (type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
      out.push({ role: 'user', blocks: [{ type: 'text', text: p.message }] });
    } else if (type === 'response_item') {
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const blocks = codexContentBlocks(p.content);
        if (blocks.length) out.push({ role: p.role, blocks });
      } else if (p.type === 'function_call') {
        out.push({
          role: 'assistant',
          blocks: [{ type: 'tool_call', text: p.name ?? 'tool', detail: p.arguments ?? '' }],
        });
      } else if (p.type === 'function_call_output') {
        out.push({
          role: 'assistant',
          blocks: [{ type: 'tool_result', text: 'result', detail: safeStringify(p) }],
        });
      }
    }
  }
  return out;
}

function codexContentBlocks(content: unknown): ConversationBlock[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ConversationBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: string };
    if (p.type === 'output_text' && typeof p.text === 'string') {
      blocks.push({ type: 'text', text: p.text });
    }
  }
  return blocks;
}

// --- opencode -------------------------------------------------------------

function renderOpencode(lines: string[]): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  for (const line of lines) {
    const obj = parseJson(line);
    if (!obj || typeof obj !== 'object') continue;
    const role = (obj as { role?: string }).role;
    const content = (obj as { content?: unknown }).content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') continue;
    if (content.trim()) out.push({ role, blocks: [{ type: 'text', text: content }] });
  }
  return out;
}

// --- helpers --------------------------------------------------------------

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
