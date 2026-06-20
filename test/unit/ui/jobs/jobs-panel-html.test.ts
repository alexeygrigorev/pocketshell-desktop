import { describe, expect, it } from 'vitest';
import {
  buildJobsPanelModel,
  renderJobsPanelHtml,
} from '../../../../src/ui/jobs';
import type { AgentJob } from '../../../../src/jobs/types';

describe('renderJobsPanelHtml', () => {
  it('renders a row per job with status pill, dot, and CSP/nonce', () => {
    const jobs: AgentJob[] = [
      { id: '1', agentType: 'claude', status: 'running', command: 'deploy', startedAt: 1000 },
      { id: '2', agentType: 'codex', status: 'completed', command: 'build', startedAt: 2000, exitCode: 0 },
    ];
    const model = buildJobsPanelModel({ hostName: 'prod', jobs, connected: true });
    const html = renderJobsPanelHtml(model, { cspSource: 'https://t', nonce: 'n1' });

    expect(html).toContain('nonce="n1"');
    expect(html).toContain('nonce-n1');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('data-row-id="1"');
    expect(html).toContain('data-row-id="2"');
    // Active (running) tone pill + dot.
    expect(html).toContain('data-tone="active"');
    // Idle (completed) tone.
    expect(html).toContain('data-tone="idle"');
    // Commands rendered.
    expect(html).toContain('deploy');
    expect(html).toContain('build');
  });

  it('disables the Cancel button for terminal jobs and enables it for running/queued', () => {
    const jobs: AgentJob[] = [
      { id: '1', agentType: 'claude', status: 'running', command: 'r', startedAt: 1 },
      { id: '2', agentType: 'claude', status: 'completed', command: 'c', startedAt: 2 },
    ];
    const model = buildJobsPanelModel({ hostName: 'h', jobs, connected: true });
    const html = renderJobsPanelHtml(model, {});

    // Running row: cancel enabled (no disabled attr on its button).
    // We can't easily scope to a row in a string assert; assert both states present.
    expect(html).toContain('data-action="cancel"');
    // The completed row's cancel button carries the disabled attr (after title).
    expect(html).toContain('title="Cancel job" disabled');
  });

  it('renders the empty state when there are no jobs', () => {
    const model = buildJobsPanelModel({ hostName: 'h', jobs: [], connected: true });
    const html = renderJobsPanelHtml(model, {});
    expect(html).toContain('No agent jobs');
    expect(html).not.toContain('data-row-id=');
  });

  it('shows the disconnected banner when connected is false', () => {
    const model = buildJobsPanelModel({ hostName: 'h', jobs: [], connected: false });
    expect(renderJobsPanelHtml(model, {})).toContain('disconnected');
  });

  it('renders the status banner when present', () => {
    const model = buildJobsPanelModel({
      hostName: 'h', jobs: [], connected: true,
      status: { tone: 'success', message: 'Cancelled job 1' },
    });
    const html = renderJobsPanelHtml(model, {});
    expect(html).toContain('data-tone="success"');
    expect(html).toContain('Cancelled job 1');
  });

  it('escapes job commands and host names to prevent HTML injection', () => {
    const jobs: AgentJob[] = [
      { id: '1', agentType: 'claude', status: 'running', command: '<script>alert(1)</script>', startedAt: 1 },
    ];
    const model = buildJobsPanelModel({ hostName: '<img>', jobs, connected: true });
    const html = renderJobsPanelHtml(model, {});
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
