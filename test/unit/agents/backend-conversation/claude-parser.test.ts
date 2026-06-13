/**
 * Unit tests for Claude session log parser (extension backend port).
 *
 * These mirror test/unit/agents/conversation/claude-parser.test.ts but
 * exercise the ported sources under
 * extensions/pocketshell/src/backend/agents/conversation/.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseClaudeSession, resetIdCounter } from '../../../../extensions/pocketshell/src/backend/agents/conversation/parsers/claude-parser';
import * as fs from 'fs';
import * as path from 'path';

// Load fixture data
const fixturePath = path.resolve(
  __dirname,
  '../../../fixtures/docker/agent-fixtures/claude-session.jsonl',
);
const fixtureContent = fs.readFileSync(fixturePath, 'utf-8');
const fixtureLines = fixtureContent.split('\n').filter(l => l.trim());

describe('parseClaudeSession', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  it('parses user message', () => {
    const session = parseClaudeSession([
      '{"type":"message","role":"user","content":"Fix the authentication bug in login.ts","ts":"2026-01-01T00:00:00Z"}',
    ]);

    expect(session.messages).toHaveLength(1);
    const msg = session.messages[0];
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Fix the authentication bug in login.ts');
    expect(msg.timestamp).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    expect(msg.id).toBeTruthy();
  });

  it('parses assistant message', () => {
    const session = parseClaudeSession([
      '{"type":"message","role":"assistant","content":"I will analyze the bug.","ts":"2026-01-01T00:00:05Z"}',
    ]);

    expect(session.messages).toHaveLength(1);
    const msg = session.messages[0];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('I will analyze the bug.');
  });

  it('parses tool_use + tool_result pair', () => {
    const lines = [
      '{"type":"tool_use","tool":"Read","input":{"file_path":"src/login.ts"},"ts":"2026-01-01T00:00:08Z"}',
      '{"type":"tool_result","output":"file contents here","ts":"2026-01-01T00:00:09Z"}',
    ];

    const session = parseClaudeSession(lines);

    // tool_use creates a message; tool_result attaches to it
    expect(session.messages).toHaveLength(1);
    const msg = session.messages[0];
    expect(msg.role).toBe('tool');
    expect(msg.toolName).toBe('Read');
    expect(msg.toolInput).toEqual({ file_path: 'src/login.ts' });
    expect(msg.toolOutput).toBe('file contents here');
  });

  it('handles malformed lines gracefully', () => {
    const lines = [
      'this is not json',
      '{"type":"message","role":"user","content":"Hello","ts":"2026-01-01T00:00:00Z"}',
      '',
      '   ',
      '{"invalid": true}',
    ];

    const session = parseClaudeSession(lines);

    // Only the valid user message should be parsed
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('Hello');
  });

  it('computes message count', () => {
    const session = parseClaudeSession(fixtureLines);

    expect(session.messageCount).toBe(session.messages.length);
    expect(session.messageCount).toBeGreaterThan(0);
  });

  it('sets session timestamps from messages', () => {
    const session = parseClaudeSession([
      '{"type":"message","role":"user","content":"First","ts":"2026-01-01T00:00:00Z"}',
      '{"type":"message","role":"assistant","content":"Second","ts":"2026-01-01T00:00:10Z"}',
    ]);

    expect(session.startedAt).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    expect(session.endedAt).toBe(new Date('2026-01-01T00:00:10Z').getTime());
  });

  it('sets agent type to claude', () => {
    const session = parseClaudeSession(fixtureLines);
    expect(session.agentType).toBe('claude');
  });

  it('accumulates token counts from cost fields', () => {
    const session = parseClaudeSession([
      '{"type":"message","role":"user","content":"Hi","ts":"2026-01-01T00:00:00Z"}',
      '{"type":"message","role":"assistant","content":"Hello","ts":"2026-01-01T00:00:05Z","cost":{"input":100,"output":50,"usd":0.001}}',
    ]);

    expect(session.messages[1].tokenCount).toBe(150);
    expect(session.totalTokens).toBe(150);
  });

  it('parses full fixture without errors', () => {
    const session = parseClaudeSession(fixtureLines);

    expect(session.messages.length).toBeGreaterThan(0);
    expect(session.id).toContain('claude-');
    expect(session.startedAt).toBeGreaterThan(0);
  });
});
