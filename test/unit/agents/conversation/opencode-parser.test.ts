/**
 * Unit tests for OpenCode session log parser.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseOpenCodeSession, resetIdCounter } from '../../../../src/agents/conversation/parsers/opencode-parser';
import * as fs from 'fs';
import * as path from 'path';

// Load fixture data
const fixturePath = path.resolve(
  __dirname,
  '../../../fixtures/docker/agent-fixtures/opencode-rows.jsonl',
);
const fixtureContent = fs.readFileSync(fixturePath, 'utf-8');
const fixtureLines = fixtureContent.split('\n').filter(l => l.trim());

describe('parseOpenCodeSession', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  it('parses user message', () => {
    const session = parseOpenCodeSession([
      '{"type":"user","content":"Refactor the API module","ts":"2026-01-01T00:02:00Z","session":"test-session"}',
    ]);

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[0].content).toBe('Refactor the API module');
  });

  it('parses assistant message', () => {
    const session = parseOpenCodeSession([
      '{"type":"assistant","content":"Starting refactor.","ts":"2026-01-01T00:02:05Z","session":"test-session"}',
    ]);

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe('assistant');
    expect(session.messages[0].content).toBe('Starting refactor.');
  });

  it('parses tool_use + tool_result pair', () => {
    const lines = [
      '{"type":"tool_use","tool":"Read","input":{"file_path":"api/routes.py"},"ts":"2026-01-01T00:02:08Z","session":"s1"}',
      '{"type":"tool_result","output":"file contents","ts":"2026-01-01T00:02:09Z","session":"s1"}',
    ];

    const session = parseOpenCodeSession(lines);

    // tool_result attaches to the tool_use
    expect(session.messages).toHaveLength(1);
    const msg = session.messages[0];
    expect(msg.role).toBe('tool');
    expect(msg.toolName).toBe('Read');
    expect(msg.toolInput).toEqual({ file_path: 'api/routes.py' });
    expect(msg.toolOutput).toBe('file contents');
  });

  it('uses session name as session id', () => {
    const session = parseOpenCodeSession(fixtureLines);
    expect(session.id).toBe('opencode-lab');
  });

  it('computes message count', () => {
    const session = parseOpenCodeSession(fixtureLines);
    expect(session.messageCount).toBe(session.messages.length);
    expect(session.messageCount).toBeGreaterThan(0);
  });

  it('sets agent type to opencode', () => {
    const session = parseOpenCodeSession(fixtureLines);
    expect(session.agentType).toBe('opencode');
  });

  it('handles malformed lines gracefully', () => {
    const lines = [
      'garbage',
      '{"type":"user","content":"Hello","ts":"2026-01-01T00:00:00Z"}',
      '',
      '{}',
    ];

    const session = parseOpenCodeSession(lines);
    expect(session.messages).toHaveLength(1);
  });

  it('parses full fixture without errors', () => {
    const session = parseOpenCodeSession(fixtureLines);

    expect(session.messages.length).toBeGreaterThan(0);
    expect(session.startedAt).toBeGreaterThan(0);
  });
});
