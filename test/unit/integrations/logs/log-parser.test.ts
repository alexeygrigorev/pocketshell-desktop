import { describe, it, expect } from 'vitest';
import { parseLogs, filterLogs } from '../../../../src/integrations/logs/log-parser';
import type { LogEntry } from '../../../../src/integrations/logs/types';

// ---------------------------------------------------------------------------
// parseLogs
// ---------------------------------------------------------------------------

describe('parseLogs', () => {
  it('parses NDJSON log entries', () => {
    const input = [
      '{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"server started","kind":"agent"}',
      '{"ts":"2026-01-01T00:01:00Z","level":"warn","msg":"slow query","kind":"db","duration_ms":120}',
      '{"ts":"2026-01-01T00:02:00Z","level":"error","msg":"connection lost","kind":"ssh","code":"ECONNREFUSED"}',
    ].join('\n');

    const entries = parseLogs(input);

    expect(entries).toHaveLength(3);

    // First entry
    expect(entries[0].timestamp).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    expect(entries[0].level).toBe('info');
    expect(entries[0].message).toBe('server started');
    expect(entries[0].source).toBe('agent');

    // Second entry — extra keys go to metadata
    expect(entries[1].level).toBe('warn');
    expect(entries[1].message).toBe('slow query');
    expect(entries[1].source).toBe('db');
    expect(entries[1].metadata).toEqual({ duration_ms: 120 });

    // Third entry
    expect(entries[2].level).toBe('error');
    expect(entries[2].source).toBe('ssh');
    expect(entries[2].metadata).toEqual({ code: 'ECONNREFUSED' });
  });

  it('handles numeric timestamps', () => {
    const input = '{"ts":1735689600000,"msg":"numeric ts","level":"debug"}';
    const entries = parseLogs(input);
    expect(entries).toHaveLength(1);
    expect(entries[0].timestamp).toBe(1735689600000);
  });

  it('defaults level to info when missing or invalid', () => {
    const input = [
      '{"ts":"2026-01-01T00:00:00Z","msg":"no level"}',
      '{"ts":"2026-01-01T00:00:00Z","msg":"bad level","level":"verbose"}',
    ].join('\n');

    const entries = parseLogs(input);
    expect(entries).toHaveLength(2);
    expect(entries[0].level).toBe('info');
    expect(entries[1].level).toBe('info');
  });

  it('handles malformed lines gracefully', () => {
    const input = [
      '{"ts":"2026-01-01T00:00:00Z","msg":"good entry"}',
      'not json at all',
      '',
      '  ',
      '{"broken json',
      '{"ts":"2026-01-01T00:01:00Z","msg":"also good"}',
    ].join('\n');

    const entries = parseLogs(input);
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe('good entry');
    expect(entries[1].message).toBe('also good');
  });

  it('skips entries with no timestamp', () => {
    const input = '{"msg":"no timestamp"}';
    const entries = parseLogs(input);
    expect(entries).toHaveLength(0);
  });

  it('skips entries with unparseable timestamps', () => {
    const input = '{"ts":"not-a-date","msg":"bad ts"}';
    const entries = parseLogs(input);
    expect(entries).toHaveLength(0);
  });

  it('accepts fixture-style log output', () => {
    const input = '{"ts":"2026-01-01T00:00:00Z","kind":"agent","msg":"fixture log entry"}';
    const entries = parseLogs(input);
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('agent');
    expect(entries[0].message).toBe('fixture log entry');
    expect(entries[0].level).toBe('info'); // default
  });
});

// ---------------------------------------------------------------------------
// filterLogs
// ---------------------------------------------------------------------------

describe('filterLogs', () => {
  const entries: LogEntry[] = [
    { timestamp: 1000, level: 'debug', message: 'debugging init', source: 'agent' },
    { timestamp: 2000, level: 'info', message: 'server started', source: 'agent' },
    { timestamp: 3000, level: 'warn', message: 'slow query detected', source: 'db' },
    { timestamp: 4000, level: 'error', message: 'Connection refused', source: 'ssh' },
    { timestamp: 5000, level: 'info', message: 'retry succeeded', source: 'ssh' },
  ];

  it('filters by level', () => {
    const result = filterLogs(entries, { level: 'error' });
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('Connection refused');
  });

  it('filters by source', () => {
    const result = filterLogs(entries, { source: 'ssh' });
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.source === 'ssh')).toBe(true);
  });

  it('filters by time range (since)', () => {
    const result = filterLogs(entries, { since: 3000 });
    expect(result).toHaveLength(3);
    expect(result[0].timestamp).toBe(3000);
  });

  it('filters by time range (until)', () => {
    const result = filterLogs(entries, { until: 3000 });
    expect(result).toHaveLength(2);
    expect(result[1].timestamp).toBe(2000);
  });

  it('filters by time range (since + until)', () => {
    const result = filterLogs(entries, { since: 2000, until: 5000 });
    expect(result).toHaveLength(3);
    expect(result[0].timestamp).toBe(2000);
    expect(result[2].timestamp).toBe(4000);
  });

  it('filters by text search (case-insensitive)', () => {
    const result = filterLogs(entries, { search: 'connection' });
    // "Connection refused" and "retry succeeded" — only first matches
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('Connection refused');
  });

  it('combines multiple filter criteria (AND)', () => {
    const result = filterLogs(entries, { source: 'ssh', level: 'info' });
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('retry succeeded');
  });

  it('returns all entries when filter is empty', () => {
    const result = filterLogs(entries, {});
    expect(result).toHaveLength(entries.length);
  });

  it('returns empty array when nothing matches', () => {
    const result = filterLogs(entries, { source: 'nonexistent' });
    expect(result).toHaveLength(0);
  });
});
