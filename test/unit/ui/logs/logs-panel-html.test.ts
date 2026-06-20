import { describe, expect, it } from 'vitest';
import {
  buildLogsPanelModel,
  renderLogsPanelHtml,
} from '../../../../src/ui/logs';
import type { LogEntry } from '../../../../src/integrations/logs/types';

describe('renderLogsPanelHtml', () => {
  it('renders a line per entry with level tone, source, and CSP/nonce', () => {
    const entries: LogEntry[] = [
      { timestamp: 1000, level: 'info', message: 'hello', source: 'agent' },
      { timestamp: 2000, level: 'error', message: 'boom', source: 'daemon' },
    ];
    const model = buildLogsPanelModel({
      hostName: 'prod',
      entries,
      maxEntries: 500,
      connected: true,
      tailing: true,
    });
    const html = renderLogsPanelHtml(model, { cspSource: 'https://t', nonce: 'n1' });

    expect(html).toContain('nonce="n1"');
    expect(html).toContain('nonce-n1');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('id="log-line-0"');
    expect(html).toContain('id="log-line-1"');
    expect(html).toContain('data-tone="info"');
    expect(html).toContain('data-tone="error"');
    expect(html).toContain('hello');
    expect(html).toContain('boom');
    // Tailing pill shown when tailing.
    expect(html).toContain('data-tone="tailing"');
    // Auto-scroll script present.
    expect(html).toContain('scrollToBottom');
  });

  it('renders the empty state when there are no entries', () => {
    const model = buildLogsPanelModel({
      hostName: 'h', entries: [], maxEntries: 500, connected: true, tailing: false,
    });
    const html = renderLogsPanelHtml(model, {});
    expect(html).toContain('No log entries');
    expect(html).not.toContain('id="log-line-');
  });

  it('shows the disconnected pill when connected is false', () => {
    const model = buildLogsPanelModel({
      hostName: 'h', entries: [], maxEntries: 500, connected: false, tailing: false,
    });
    expect(renderLogsPanelHtml(model, {})).toContain('data-tone="disconnected"');
  });

  it('reports dropped and total counts in the footer', () => {
    const entries: LogEntry[] = Array.from({ length: 3 }, (_, i) =>
      ({ timestamp: i + 1, level: 'info' as const, message: `m${i}` }),
    );
    const model = buildLogsPanelModel({
      hostName: 'h', entries, maxEntries: 1, connected: true, tailing: false,
    });
    const html = renderLogsPanelHtml(model, {});
    expect(model.dropped).toBe(2);
    expect(html).toContain('2 dropped');
    expect(html).toContain('3 total');
    expect(html).toContain('1 shown');
  });

  it('renders the status banner when present', () => {
    const model = buildLogsPanelModel({
      hostName: 'h', entries: [], maxEntries: 500, connected: true, tailing: false,
      status: { tone: 'warning', message: 'Tailing logs' },
    });
    const html = renderLogsPanelHtml(model, {});
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain('Tailing logs');
  });

  it('escapes log messages to prevent HTML injection', () => {
    const entries: LogEntry[] = [
      { timestamp: 1, level: 'info', message: '<script>alert(1)</script>' },
    ];
    const model = buildLogsPanelModel({
      hostName: '<img>', entries, maxEntries: 500, connected: true, tailing: false,
    });
    const html = renderLogsPanelHtml(model, {});
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
