import { describe, expect, it } from 'vitest';
import {
  buildJobsPanelModel,
  jobCardStatus,
} from '../../../../src/ui/jobs';
import type { AgentJob } from '../../../../src/jobs/types';

describe('jobCardStatus', () => {
  it('maps active lifecycle states to active tone', () => {
    expect(jobCardStatus('running')).toBe('active');
    expect(jobCardStatus('queued')).toBe('active');
  });

  it('maps failed terminal states to error tone', () => {
    expect(jobCardStatus('failed')).toBe('error');
    expect(jobCardStatus('cancelled')).toBe('error');
  });

  it('maps completed to idle tone', () => {
    expect(jobCardStatus('completed')).toBe('idle');
  });
});

describe('buildJobsPanelModel', () => {
  it('sorts jobs by relevance (running first) and carries through fields', () => {
    const jobs: AgentJob[] = [
      job('1', 'completed', 'build docs', 1000),
      job('2', 'running', 'deploy app', 2000),
      job('3', 'queued', 'lint', 3000),
    ];
    const model = buildJobsPanelModel({
      hostName: 'prod',
      jobs,
      connected: true,
    });

    expect(model.rows.map((r) => r.id)).toEqual(['2', '3', '1']);
    const running = model.rows[0];
    expect(running.cardStatus).toBe('active');
    expect(running.command).toBe('deploy app');
    expect(running.status).toBe('running');
  });

  it('breaks status ties by most recent startedAt', () => {
    const jobs: AgentJob[] = [
      job('a', 'running', 'old', 1000),
      job('b', 'running', 'new', 5000),
    ];
    const model = buildJobsPanelModel({
      hostName: 'prod',
      jobs,
      connected: true,
    });
    expect(model.rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('reports empty-text when there are no jobs', () => {
    const model = buildJobsPanelModel({
      hostName: 'prod',
      jobs: [],
      connected: true,
    });
    expect(model.rows).toHaveLength(0);
    expect(model.emptyText).toMatch(/No agent jobs/);
  });

  it('carries the connection + status banner through', () => {
    const ok = buildJobsPanelModel({
      hostName: 'h', jobs: [], connected: true,
    });
    expect(ok.connected).toBe(true);
    expect(ok.status).toBeUndefined();

    const withStatus = buildJobsPanelModel({
      hostName: 'h', jobs: [], connected: false,
      status: { tone: 'error', message: 'boom' },
    });
    expect(withStatus.connected).toBe(false);
    expect(withStatus.status).toEqual({ tone: 'error', message: 'boom' });
  });

  it('preserves sessionId, exitCode, cwd, completedAt', () => {
    const jobs: AgentJob[] = [{
      id: '7',
      agentType: 'codex',
      status: 'completed',
      command: 'done',
      startedAt: 1000,
      completedAt: 2000,
      exitCode: 0,
      sessionId: 'main',
      cwd: '/home/u/app',
    }];
    const model = buildJobsPanelModel({ hostName: 'h', jobs, connected: true });
    const row = model.rows[0];
    expect(row.sessionId).toBe('main');
    expect(row.exitCode).toBe(0);
    expect(row.cwd).toBe('/home/u/app');
    expect(row.completedAt).toBe(2000);
  });
});

function job(id: string, status: AgentJob['status'], command: string, startedAt: number): AgentJob {
  return {
    id,
    agentType: 'claude',
    status,
    command,
    startedAt,
  };
}
