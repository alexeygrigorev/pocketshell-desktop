import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogsClient } from '../../../../src/integrations/logs/logs-client';
import type { SshConnection, ExecResult } from '../../../../src/ssh/connection/ssh-client';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockConnection(
  responses: Map<string, ExecResult>,
): SshConnection {
  return {
    connected: true,
    exec: vi.fn(async (command: string): Promise<ExecResult> => {
      for (const [key, result] of responses) {
        if (command.includes(key)) {
          return result;
        }
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    shell: vi.fn(),
    sftp: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as SshConnection;
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_NDJSON = [
  '{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"server started","kind":"agent"}',
  '{"ts":"2026-01-01T00:01:00Z","level":"warn","msg":"slow query","kind":"db"}',
  '{"ts":"2026-01-01T00:02:00Z","level":"error","msg":"connection lost","kind":"ssh"}',
].join('\n');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogsClient', () => {
  let mockConn: SshConnection;

  beforeEach(() => {
    mockConn = createMockConnection(
      new Map([['pocketshell logs', { stdout: SAMPLE_NDJSON, stderr: '', exitCode: 0 }]]),
    );
  });

  // ---- getLogs ----

  describe('getLogs', () => {
    it('returns parsed log entries', async () => {
      const client = new LogsClient(mockConn);
      const entries = await client.getLogs();

      expect(entries).toHaveLength(3);
      expect(entries[0].message).toBe('server started');
      expect(entries[1].message).toBe('slow query');
      expect(entries[2].message).toBe('connection lost');
    });

    it('passes filter to filterLogs', async () => {
      const client = new LogsClient(mockConn);
      const entries = await client.getLogs({ level: 'error' });

      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe('connection lost');
      expect(entries[0].level).toBe('error');
    });

    it('throws when remote command fails', async () => {
      const failingConn = createMockConnection(
        new Map([
          [
            'pocketshell logs',
            { stdout: '', stderr: 'command not found', exitCode: 127 },
          ],
        ]),
      );

      const client = new LogsClient(failingConn);
      await expect(client.getLogs()).rejects.toThrow('pocketshell logs failed');
    });

    it('calls exec with correct command', async () => {
      const client = new LogsClient(mockConn);
      await client.getLogs();

      expect(mockConn.exec).toHaveBeenCalledWith(
        'pocketshell logs',
        expect.any(Number),
      );
    });
  });

  // ---- clear ----

  describe('clear', () => {
    it('sends clear command', async () => {
      const clearConn = createMockConnection(
        new Map([
          ['clear', { stdout: '', stderr: '', exitCode: 0 }],
        ]),
      );

      const client = new LogsClient(clearConn);
      await client.clear();

      expect(clearConn.exec).toHaveBeenCalledWith(
        'pocketshell logs clear',
        expect.any(Number),
      );
    });

    it('throws when clear command fails', async () => {
      const failingConn = createMockConnection(
        new Map([
          [
            'clear',
            { stdout: '', stderr: 'permission denied', exitCode: 1 },
          ],
        ]),
      );

      const client = new LogsClient(failingConn);
      await expect(client.clear()).rejects.toThrow('pocketshell logs clear failed');
    });
  });
});
