import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderConversation } from '@main/agents/conversation';

const FIXTURES = resolve(__dirname, '..', '..', 'tests-docker', 'fixtures');
const readLines = (name: string): string[] =>
  readFileSync(resolve(FIXTURES, name), 'utf8').split(/\r?\n/).filter(Boolean);

describe('renderConversation', () => {
  it('renders claude JSONL into user/assistant messages with tool calls', () => {
    const msgs = renderConversation('claude', readLines('claude-session.jsonl'));
    expect(msgs.length).toBeGreaterThan(0);
    // First message is the user prompt.
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.blocks[0]!.type).toBe('text');
    // An assistant message has a tool_use block.
    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant).toBeTruthy();
    expect(assistant!.blocks.some((b) => b.type === 'tool_call')).toBe(true);
  });

  it('renders codex JSONL into messages', () => {
    const msgs = renderConversation('codex', readLines('codex-session.jsonl'));
    expect(msgs.length).toBeGreaterThan(0);
    // Codex user_message becomes a user message.
    const user = msgs.find((m) => m.role === 'user');
    expect(user).toBeTruthy();
    expect(user!.blocks[0]!.text).toBeTruthy();
    // function_call becomes a tool_call.
    expect(msgs.some((m) => m.blocks.some((b) => b.type === 'tool_call'))).toBe(true);
  });

  it('renders opencode JSONL into messages', () => {
    const msgs = renderConversation('opencode', readLines('opencode-rows.jsonl'));
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('handles empty/malformed lines gracefully', () => {
    expect(renderConversation('claude', [])).toEqual([]);
    expect(renderConversation('claude', ['not json', '{"no":"message"}'])).toEqual([]);
  });

  it('tool_call blocks carry expandable detail', () => {
    const msgs = renderConversation('claude', readLines('claude-session.jsonl'));
    const toolCall = msgs.flatMap((m) => m.blocks).find((b) => b.type === 'tool_call');
    expect(toolCall).toBeTruthy();
    expect(toolCall!.detail).toBeTruthy();
  });
});
