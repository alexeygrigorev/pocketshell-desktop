import { describe, expect, it } from 'vitest';
import {
  buildLogsPanelModel,
  logLineTone,
} from '../../../../src/ui/logs';
import type { LogEntry } from '../../../../src/integrations/logs/types';

describe('logLineTone', () => {
  it('passes the level through as the render tone', () => {
    expect(logLineTone('debug')).toBe('debug');
    expect(logLineTone('info')).toBe('info');
    expect(logLineTone('warn')).toBe('warn');
    expect(logLineTone('error')).toBe('error');
  });
});

describe('buildLogsPanelModel', () => {
  it('sorts entries ascending by timestamp and assigns monotonic seqs', () => {
    const entries: LogEntry[] = [
      entry(3000, 'info', 'third'),
      entry(1000, 'info', 'first'),
      entry(2000, 'warn', 'second'),
    ];
    const model = buildLogsPanelModel({
      hostName: 'prod',
      entries,
      maxEntries: 500,
      connected: true,
      tailing: false,
    });
    expect(model.lines.map((l) => l.message)).toEqual(['first', 'second', 'third']);
    expect(model.lines.map((l) => l.seq)).toEqual([0, 1, 2]);
    expect(model.totalSeen).toBe(3);
    expect(model.dropped).toBe(0);
  });

  it('bounds to maxEntries and reports dropped head entries', () => {
    const entries: LogEntry[] = Array.from({ length: 5 }, (_, i) =>
      entry(i + 1, 'info', `m${i}`),
    );
    const model = buildLogsPanelModel({
      hostName: 'prod',
      entries,
      maxEntries: 2,
      connected: true,
      tailing: false,
    });
    // Keeps the most recent 2; drops 3 from the head.
    expect(model.lines.map((l) => l.message)).toEqual(['m3', 'm4']);
    expect(model.dropped).toBe(3);
    expect(model.totalSeen).toBe(5);
    // Seqs continue past the dropped head.
    expect(model.lines.map((l) => l.seq)).toEqual([3, 4]);
  });

  it('carries previous totals across renders (streaming accumulation)', () => {
    const model = buildLogsPanelModel({
      hostName: 'prod',
      entries: [entry(10, 'info', 'new')],
      maxEntries: 500,
      connected: true,
      tailing: true,
      previousDropped: 7,
      previousTotalSeen: 42,
      startSeq: 42,
    });
    expect(model.totalSeen).toBe(43);
    expect(model.dropped).toBe(7);
    expect(model.lines[0].seq).toBe(42);
    expect(model.tailing).toBe(true);
  });

  it('reports empty-text when there are no entries', () => {
    const model = buildLogsPanelModel({
      hostName: 'prod',
      entries: [],
      maxEntries: 500,
      connected: true,
      tailing: false,
    });
    expect(model.lines).toHaveLength(0);
    expect(model.emptyText).toMatch(/No log entries/);
  });

  it('preserves source and level on each line', () => {
    const entries: LogEntry[] = [
      { timestamp: 1, level: 'error', message: 'boom', source: 'agent' },
    ];
    const model = buildLogsPanelModel({
      hostName: 'h', entries, maxEntries: 500, connected: true, tailing: false,
    });
    expect(model.lines[0].source).toBe('agent');
    expect(model.lines[0].level).toBe('error');
    expect(model.lines[0].tone).toBe('error');
  });

  it('handles maxEntries of 0 gracefully', () => {
    const model = buildLogsPanelModel({
      hostName: 'h',
      entries: [entry(1, 'info', 'x')],
      maxEntries: 0,
      connected: true,
      tailing: false,
    });
    expect(model.lines).toHaveLength(0);
    expect(model.dropped).toBe(1);
  });
});

function entry(timestamp: number, level: LogEntry['level'], message: string): LogEntry {
  return { timestamp, level, message };
}
