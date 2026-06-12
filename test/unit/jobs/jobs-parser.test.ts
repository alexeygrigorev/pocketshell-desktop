/**
 * Unit tests for jobs output parser.
 *
 * Tests parseJobsList with table and JSON formats.
 */

import { describe, it, expect } from 'vitest';
import { parseJobsList } from '../../../src/jobs/jobs-parser';

describe('parseJobsList', () => {
  describe('table format', () => {
    it('parses fixture table output', () => {
      const output = [
        '1  fix-auth-bug       TODO     Implement JWT token refresh        claude     2026-01-01 00:00',
        '2  add-tests          WIP      Add integration tests for login     codex      2026-01-01 00:01',
        '3  refactor-api       TODO     Refactor API to use FastAPI         opencode   2026-01-01 00:02',
      ].join('\n');

      const jobs = parseJobsList(output);

      expect(jobs).toHaveLength(3);

      expect(jobs[0].id).toBe('1');
      expect(jobs[0].command).toBe('Implement JWT token refresh');
      expect(jobs[0].agentType).toBe('claude');
      expect(jobs[0].status).toBe('queued');

      expect(jobs[1].id).toBe('2');
      expect(jobs[1].command).toBe('Add integration tests for login');
      expect(jobs[1].agentType).toBe('codex');
      expect(jobs[1].status).toBe('running');

      expect(jobs[2].id).toBe('3');
      expect(jobs[2].command).toBe('Refactor API to use FastAPI');
      expect(jobs[2].agentType).toBe('opencode');
      expect(jobs[2].status).toBe('queued');
    });

    it('parses a single job', () => {
      const output = '1  my-job  RUNNING  Do something  claude  2026-06-12 10:30';

      const jobs = parseJobsList(output);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('1');
      expect(jobs[0].command).toBe('Do something');
      expect(jobs[0].agentType).toBe('claude');
      expect(jobs[0].status).toBe('running');
    });

    it('handles varying whitespace', () => {
      const output = '1  job-a   DONE   Short desc   codex   2026-01-15 12:00';

      const jobs = parseJobsList(output);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('1');
      expect(jobs[0].status).toBe('completed');
    });
  });

  describe('JSON format', () => {
    it('parses JSON array of jobs', () => {
      const output = JSON.stringify([
        {
          id: 'j1',
          agentType: 'claude',
          status: 'running',
          command: 'Fix auth bug',
          startedAt: 1735689600000,
        },
        {
          id: 'j2',
          agentType: 'codex',
          status: 'completed',
          command: 'Add tests',
          startedAt: 1735689660000,
          completedAt: 1735690000000,
          exitCode: 0,
        },
      ]);

      const jobs = parseJobsList(output);

      expect(jobs).toHaveLength(2);
      expect(jobs[0].id).toBe('j1');
      expect(jobs[0].status).toBe('running');
      expect(jobs[0].agentType).toBe('claude');
      expect(jobs[1].id).toBe('j2');
      expect(jobs[1].status).toBe('completed');
      expect(jobs[1].completedAt).toBe(1735690000000);
      expect(jobs[1].exitCode).toBe(0);
    });

    it('parses single JSON object', () => {
      const output = JSON.stringify({
        id: 'j1',
        agentType: 'opencode',
        status: 'failed',
        command: 'Deploy',
        startedAt: 1735689600000,
        exitCode: 1,
      });

      const jobs = parseJobsList(output);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('j1');
      expect(jobs[0].status).toBe('failed');
      expect(jobs[0].agentType).toBe('opencode');
      expect(jobs[0].exitCode).toBe(1);
    });

    it('handles snake_case field names', () => {
      const output = JSON.stringify([{
        id: 'j1',
        agent_type: 'codex',
        session_id: 'sess-1',
        status: 'cancelled',
        description: 'Refactor module',
        started_at: 1735689600000,
        completed_at: 1735690000000,
        exit_code: 130,
        cwd: '/home/user/project',
      }]);

      const jobs = parseJobsList(output);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].agentType).toBe('codex');
      expect(jobs[0].sessionId).toBe('sess-1');
      expect(jobs[0].status).toBe('cancelled');
      expect(jobs[0].command).toBe('Refactor module');
      expect(jobs[0].cwd).toBe('/home/user/project');
      expect(jobs[0].completedAt).toBe(1735690000000);
      expect(jobs[0].exitCode).toBe(130);
    });

    it('handles engine field as fallback for agentType', () => {
      const output = JSON.stringify([{
        id: 'j1',
        engine: 'opencode',
        status: 'queued',
        command: 'Analyze codebase',
        startedAt: 1735689600000,
      }]);

      const jobs = parseJobsList(output);

      expect(jobs[0].agentType).toBe('opencode');
    });

    it('defaults agentType to claude when unknown', () => {
      const output = JSON.stringify([{
        id: 'j1',
        agentType: 'unknown-agent',
        status: 'running',
        command: 'Do stuff',
        startedAt: 1735689600000,
      }]);

      const jobs = parseJobsList(output);

      expect(jobs[0].agentType).toBe('claude');
    });

    it('falls back to table parser on invalid JSON', () => {
      const output = '1  my-job  RUNNING  Do something  claude  2026-06-12 10:30';

      const jobs = parseJobsList(output);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('1');
    });
  });

  describe('empty output', () => {
    it('returns empty array for empty string', () => {
      expect(parseJobsList('')).toEqual([]);
    });

    it('returns empty array for whitespace-only string', () => {
      expect(parseJobsList('   \n  \n  ')).toEqual([]);
    });
  });

  describe('status mapping', () => {
    it.each([
      ['RUNNING', 'running'],
      ['WIP', 'running'],
      ['COMPLETED', 'completed'],
      ['DONE', 'completed'],
      ['FAILED', 'failed'],
      ['ERROR', 'failed'],
      ['CANCELLED', 'cancelled'],
      ['CANCELED', 'cancelled'],
      ['QUEUED', 'queued'],
      ['TODO', 'queued'],
    ] as const)('maps %s to %s', (raw, expected) => {
      const output = `1  job  ${raw}  Description  claude  2026-01-01 00:00`;
      const jobs = parseJobsList(output);
      expect(jobs[0].status).toBe(expected);
    });
  });
});
