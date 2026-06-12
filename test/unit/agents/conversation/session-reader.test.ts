/**
 * Unit tests for SessionReader.
 *
 * Uses a mocked SshConnection to verify listing, reading, and tailing
 * without a real SSH connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionReader } from '../../../../src/agents/conversation/session-reader';
import { ExecResult } from '../../../../src/ssh/connection/ssh-client';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mock SshConnection
// ---------------------------------------------------------------------------

function createMockConnection(responses: Map<string, ExecResult>) {
  return {
    connected: true,
    exec: vi.fn(async (command: string): Promise<ExecResult> => {
      // Find a matching response by checking if the command contains a known key
      for (const [key, result] of responses) {
        if (command.includes(key)) {
          return result;
        }
      }
      return { stdout: '', stderr: '', exitCode: 1 };
    }),
    shell: vi.fn(),
    sftp: vi.fn(),
    disconnect: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function loadFixture(filename: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, `../../../fixtures/docker/agent-fixtures/${filename}`),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionReader', () => {
  let mockConnection: ReturnType<typeof createMockConnection>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listSessions', () => {
    it('returns sessions when files exist', async () => {
      const statOutput =
        '/tmp/pocketshell/sessions/claude/session-1.jsonl|1024|1735689600';

      mockConnection = createMockConnection(new Map([
        ['stat', { stdout: statOutput, stderr: '', exitCode: 0 }],
      ]));

      const reader = new SessionReader(mockConnection as any);
      const sessions = await reader.listSessions('claude');

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('session-1');
      expect(sessions[0].agentType).toBe('claude');
      expect(sessions[0].size).toBe(1024);
      expect(sessions[0].modifiedAt).toBe(1735689600 * 1000);
    });

    it('returns empty array when no sessions found', async () => {
      mockConnection = createMockConnection(new Map([
        ['stat', { stdout: '', stderr: '', exitCode: 0 }],
      ]));

      const reader = new SessionReader(mockConnection as any);
      const sessions = await reader.listSessions('claude');

      expect(sessions).toHaveLength(0);
    });

    it('lists sessions from all agent types when none specified', async () => {
      const claudeStat =
        '/tmp/pocketshell/sessions/claude/s1.jsonl|500|1735689600';
      const codexStat =
        '/tmp/pocketshell/sessions/codex/s2.jsonl|800|1735689700';

      // The command includes the directory path, so we match on directory
      mockConnection = createMockConnection(new Map([
        ['sessions/claude', { stdout: claudeStat, stderr: '', exitCode: 0 }],
        ['sessions/codex', { stdout: codexStat, stderr: '', exitCode: 0 }],
        ['sessions/opencode', { stdout: '', stderr: '', exitCode: 0 }],
      ]));

      const reader = new SessionReader(mockConnection as any);
      const sessions = await reader.listSessions();

      expect(sessions).toHaveLength(2);
      // Sorted by modifiedAt desc — codex is more recent
      expect(sessions[0].agentType).toBe('codex');
      expect(sessions[1].agentType).toBe('claude');
    });
  });

  describe('readSession', () => {
    it('parses full Claude session log', async () => {
      const fixtureContent = loadFixture('claude-session.jsonl');

      mockConnection = createMockConnection(new Map([
        ['cat', { stdout: fixtureContent, stderr: '', exitCode: 0 }],
      ]));

      const reader = new SessionReader(mockConnection as any);
      const session = await reader.readSession('session-1', 'claude');

      expect(session.id).toBe('session-1');
      expect(session.agentType).toBe('claude');
      expect(session.messages.length).toBeGreaterThan(0);
      expect(session.messageCount).toBe(session.messages.length);
    });

    it('parses full Codex session log', async () => {
      const fixtureContent = loadFixture('codex-session.jsonl');

      mockConnection = createMockConnection(new Map([
        ['cat', { stdout: fixtureContent, stderr: '', exitCode: 0 }],
      ]));

      const reader = new SessionReader(mockConnection as any);
      const session = await reader.readSession('session-2', 'codex');

      expect(session.id).toBe('session-2');
      expect(session.agentType).toBe('codex');
      expect(session.messages.length).toBeGreaterThan(0);
    });

    it('throws when session not found', async () => {
      mockConnection = createMockConnection(new Map([
        ['cat', { stdout: '', stderr: 'No such file', exitCode: 1 }],
      ]));

      const reader = new SessionReader(mockConnection as any);
      await expect(reader.readSession('nonexistent', 'claude'))
        .rejects.toThrow('Failed to read session file');
    });
  });
});
