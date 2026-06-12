/**
 * Unit tests for JobsClient.
 *
 * Uses mocked SshConnection to verify command construction
 * and output parsing without requiring a real SSH connection.
 */

import { describe, it, expect, vi } from 'vitest';
import { JobsClient } from '../../../src/jobs/jobs-client';
import type { SshConnection, ExecResult } from '../../../src/ssh/connection/ssh-client';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockConnection(
  responses: Map<string, ExecResult>,
): SshConnection {
  return {
    connected: true,
    exec: vi.fn(async (command: string): Promise<ExecResult> => {
      // Find a matching response by checking if the command contains the key
      for (const [key, result] of responses) {
        if (command.includes(key)) {
          return result;
        }
      }
      // Default response
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    shell: vi.fn(),
    sftp: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as SshConnection;
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const JOBS_TABLE_OUTPUT = [
  '1  fix-auth-bug       TODO     Implement JWT token refresh        claude     2026-01-01 00:00',
  '2  add-tests          WIP      Add integration tests for login     codex      2026-01-01 00:01',
  '3  refactor-api       TODO     Refactor API to use FastAPI         opencode   2026-01-01 00:02',
].join('\n');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobsClient', () => {
  describe('list', () => {
    it('returns parsed jobs', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell jobs list', {
          stdout: JOBS_TABLE_OUTPUT,
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new JobsClient(conn);
      const jobs = await client.list();

      expect(jobs).toHaveLength(3);
      expect(jobs[0].id).toBe('1');
      expect(jobs[0].command).toBe('Implement JWT token refresh');
      expect(jobs[0].agentType).toBe('claude');
      expect(jobs[0].status).toBe('queued');

      expect(jobs[1].id).toBe('2');
      expect(jobs[1].agentType).toBe('codex');
      expect(jobs[1].status).toBe('running');
    });

    it('throws on non-zero exit code', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell jobs list', {
          stdout: '',
          stderr: 'pocketshell: command not found',
          exitCode: 127,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new JobsClient(conn);
      await expect(client.list()).rejects.toThrow('pocketshell jobs list failed');
    });

    it('sends correct command', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell jobs list', {
          stdout: '',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new JobsClient(conn);
      await client.list();

      expect(conn.exec).toHaveBeenCalledWith('pocketshell jobs list');
    });
  });

  describe('get', () => {
    it('returns specific job by ID', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell jobs list', {
          stdout: JOBS_TABLE_OUTPUT,
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new JobsClient(conn);
      const job = await client.get('2');

      expect(job).not.toBeNull();
      expect(job!.id).toBe('2');
      expect(job!.command).toBe('Add integration tests for login');
      expect(job!.agentType).toBe('codex');
    });

    it('returns null for non-existent job', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell jobs list', {
          stdout: JOBS_TABLE_OUTPUT,
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new JobsClient(conn);
      const job = await client.get('999');

      expect(job).toBeNull();
    });
  });

  describe('cancel', () => {
    it('sends cancel command', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell jobs remove', {
          stdout: 'Removed job 1\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new JobsClient(conn);
      await client.cancel('1');

      expect(conn.exec).toHaveBeenCalledWith("pocketshell jobs remove '1'");
    });

    it('throws on non-zero exit code', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell jobs remove', {
          stdout: '',
          stderr: 'Job not found',
          exitCode: 1,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new JobsClient(conn);
      await expect(client.cancel('999')).rejects.toThrow('pocketshell jobs remove failed');
    });
  });

  describe('logs', () => {
    it('returns job output', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell jobs edit', {
          stdout: 'Updated job 1\n',
          stderr: '',
          exitCode: 0,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new JobsClient(conn);
      const output = await client.logs('1');

      expect(output).toBe('Updated job 1\n');
      expect(conn.exec).toHaveBeenCalledWith("pocketshell jobs edit '1'");
    });

    it('throws on non-zero exit code', async () => {
      const responses = new Map<string, ExecResult>([
        ['pocketshell jobs edit', {
          stdout: '',
          stderr: 'Job not found',
          exitCode: 1,
        }],
      ]);

      const conn = createMockConnection(responses);
      const client = new JobsClient(conn);
      await expect(client.logs('999')).rejects.toThrow('pocketshell jobs edit failed');
    });
  });
});
