import { describe, expect, it } from 'vitest';
import {
  buildDiagnosticsReport,
  DiagnosticsEventStore,
  fingerprintDiagnosticValue,
  normalizeDiagnosticError,
  redactDiagnosticMetadata,
  redactDiagnosticString,
} from '../../../src/diagnostics';

describe('diagnostics redaction', () => {
  it('fingerprints hostnames, usernames, tmux session names, and paths', () => {
    const redacted = redactDiagnosticMetadata({
      hostname: 'example.internal',
      username: 'alexey',
      tmuxSessionName: 'prod-session',
      keyPath: '/home/alexey/.ssh/id_ed25519',
      port: 22,
      trigger: 'manual',
    }, 'balanced');

    expect(redacted.hostname).toBe(`sha256:${fingerprintDiagnosticValue('example.internal')}`);
    expect(redacted.username).toBe(`sha256:${fingerprintDiagnosticValue('alexey')}`);
    expect(redacted.tmuxSessionName).toBe(`sha256:${fingerprintDiagnosticValue('prod-session')}`);
    expect(redacted.keyPath).toBe('[redacted]');
    expect(redacted.port).toBe(22);
    expect(redacted.trigger).toBe('manual');
  });

  it('redacts secrets and command-like inputs', () => {
    const redacted = redactDiagnosticMetadata({
      token: 'abc123',
      passphrase: 'open sesame',
      command: 'rm -rf /tmp/example',
      keys: 'password typed in terminal',
      message: 'failed token=abc123',
    }, 'balanced');

    expect(redacted.token).toBe('[redacted]');
    expect(redacted.passphrase).toBe('[redacted]');
    expect(redacted.command).toBe('[redacted]');
    expect(redacted.keys).toBe('[redacted]');
    expect(redacted.message).toBe('failed token=[redacted]');
  });

  it('redacts embedded paths, hosts, IPs, and token-like secrets in strings', () => {
    const input = [
      'getaddrinfo ENOTFOUND prod.internal',
      'open /home/alexey/.ssh/id_rsa',
      'connect 10.1.2.3',
      'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456',
      'apiKey: sk-abcdefghijklmnopqrstuvwxyz123456',
      'secret abcdefghijklmnopqrstuvwxyz1234567890',
    ].join('\n');

    const redacted = redactDiagnosticString(input, 'balanced');

    expect(redacted).not.toContain('prod.internal');
    expect(redacted).not.toContain('/home/alexey');
    expect(redacted).not.toContain('10.1.2.3');
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
    expect(redacted).toContain(`sha256:${fingerprintDiagnosticValue('prod.internal')}`);
  });

  it('normalizes errors without raw stack bodies', () => {
    const error = new Error('open /home/alexey/.ssh/id_rsa failed for prod.internal');
    error.stack = [
      'Error: open /home/alexey/.ssh/id_rsa failed for prod.internal',
      '    at connect (/home/alexey/project/src/file.ts:10:5)',
      '    at run (/home/alexey/project/src/main.ts:2:1)',
    ].join('\n');

    const normalized = normalizeDiagnosticError(error);

    expect(normalized.errorName).toBe('Error');
    expect(normalized.message).not.toContain('/home/alexey');
    expect(normalized.message).not.toContain('prod.internal');
    expect(normalized.topFrame).not.toContain('/home/alexey');
    expect(normalized).not.toHaveProperty('stack');
  });
});

describe('DiagnosticsEventStore', () => {
  it('keeps Android-style event fields in a bounded window', () => {
    const store = new DiagnosticsEventStore({ maxEvents: 2 });

    store.record({ category: 'navigation', name: 'route_changed', metadata: { route: 'settings' } });
    store.record({ category: 'ssh', name: 'connect_started', metadata: { hostId: 1 } });
    store.record({ category: 'ssh', name: 'connect_failed', metadata: { hostname: 'host.local' } });

    const events = store.list();
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(2);
    expect(events[1]).toMatchObject({
      sequence: 3,
      category: 'ssh',
      name: 'connect_failed',
    });
    expect(events[1].wallClockTime).toEqual(expect.any(String));
    expect(events[1].monotonicTimestampNanos).toEqual(expect.any(String));
  });
});

describe('buildDiagnosticsReport', () => {
  it('includes a summary marker and JSONL events', () => {
    const store = new DiagnosticsEventStore();
    store.record({ category: 'extension', name: 'command_failed', metadata: { commandId: 'pocketshell.connect' } });

    const report = buildDiagnosticsReport(store.list(), {
      appName: 'PocketShell',
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v1',
      settings: store.getConfig(),
      locations: [{ label: 'global storage', path: '/home/alexey/.config/Code/User/globalStorage/pocketshell' }],
      generatedAt: new Date('2026-01-02T03:04:05.000Z'),
    });

    expect(report).toContain('# PocketShell Desktop Diagnostics Report');
    expect(report).toContain('"category":"diagnostics","name":"summary"');
    expect(report).toContain('"category":"extension","name":"command_failed"');
    expect(report).not.toContain('/home/alexey');
    expect(report).toContain(`global storage: sha256:${fingerprintDiagnosticValue('/home/alexey/.config/Code/User/globalStorage/pocketshell')}`);
  });

  it('surfaces exceptions and rejections as recent extension errors', () => {
    const store = new DiagnosticsEventStore();
    store.record({ category: 'extension', name: 'uncaught_exception', metadata: { message: 'boom' } });
    store.record({ category: 'extension', name: 'unhandled_rejection', metadata: { message: 'nope' } });

    const report = buildDiagnosticsReport(store.list(), {
      appName: 'PocketShell',
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v1',
      settings: store.getConfig(),
      locations: [],
      generatedAt: new Date('2026-01-02T03:04:05.000Z'),
    });

    expect(report).toContain('extension/uncaught_exception');
    expect(report).toContain('extension/unhandled_rejection');
    expect(report).toContain('"recentErrorCount":2');
  });
});
