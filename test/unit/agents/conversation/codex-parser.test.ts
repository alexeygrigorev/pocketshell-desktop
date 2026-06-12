/**
 * Unit tests for Codex session log parser.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseCodexSession, resetIdCounter } from '../../../../src/agents/conversation/parsers/codex-parser';
import * as fs from 'fs';
import * as path from 'path';

// Load fixture data
const fixturePath = path.resolve(
  __dirname,
  '../../../fixtures/docker/agent-fixtures/codex-session.jsonl',
);
const fixtureContent = fs.readFileSync(fixturePath, 'utf-8');
const fixtureLines = fixtureContent.split('\n').filter(l => l.trim());

describe('parseCodexSession', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  it('parses user message', () => {
    const session = parseCodexSession([
      '{"type":"user","message":{"role":"user","content":"Fix the auth bug"},"ts":"2026-01-01T00:00:00Z"}',
    ]);

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[0].content).toBe('Fix the auth bug');
  });

  it('parses assistant message', () => {
    const session = parseCodexSession([
      '{"type":"assistant","message":{"role":"assistant","content":"I will fix it."},"ts":"2026-01-01T00:00:05Z"}',
    ]);

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe('assistant');
    expect(session.messages[0].content).toBe('I will fix it.');
  });

  it('extracts token counts from cost field', () => {
    const session = parseCodexSession([
      '{"type":"assistant","message":{"role":"assistant","content":"response"},"ts":"2026-01-01T00:00:05Z","cost":{"input":1200,"output":340,"usd":0.012}}',
    ]);

    expect(session.messages[0].tokenCount).toBe(1540);
    expect(session.totalTokens).toBe(1540);
  });

  it('computes message count', () => {
    const session = parseCodexSession(fixtureLines);
    expect(session.messageCount).toBe(session.messages.length);
    expect(session.messageCount).toBeGreaterThan(0);
  });

  it('sets agent type to codex', () => {
    const session = parseCodexSession(fixtureLines);
    expect(session.agentType).toBe('codex');
  });

  it('handles malformed lines gracefully', () => {
    const lines = [
      'not json',
      '{"type":"user","message":{"role":"user","content":"Hi"},"ts":"2026-01-01T00:00:00Z"}',
      '',
    ];

    const session = parseCodexSession(lines);
    expect(session.messages).toHaveLength(1);
  });

  it('parses full fixture without errors', () => {
    const session = parseCodexSession(fixtureLines);

    expect(session.messages.length).toBeGreaterThan(0);
    expect(session.id).toContain('codex-');
    expect(session.startedAt).toBeGreaterThan(0);
  });
});
