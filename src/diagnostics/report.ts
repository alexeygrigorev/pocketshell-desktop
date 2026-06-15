import { fingerprintDiagnosticPath } from './redaction';
import type {
  DiagnosticEvent,
  DiagnosticReportContext,
} from './types';

export function buildDiagnosticsReport(
  events: DiagnosticEvent[],
  context: DiagnosticReportContext,
): string {
  const generatedAt = context.generatedAt ?? new Date();
  const failures = events.filter(isRecentErrorEvent);
  const summary = {
    sequence: events.length > 0 ? events[events.length - 1].sequence + 1 : 1,
    wallClockTime: generatedAt.toISOString(),
    monotonicTimestampNanos: '0',
    category: 'diagnostics',
    name: 'summary',
    metadata: {
      eventCount: events.length,
      recentErrorCount: failures.length,
      redactionMode: context.settings.redactionMode,
    },
  };

  const lines: string[] = [
    '# PocketShell Desktop Diagnostics Report',
    '',
    `Generated: ${generatedAt.toISOString()}`,
    `App: ${context.appName}`,
    `Extension version: ${context.extensionVersion ?? 'unknown'}`,
    `VS Code version: ${context.vscodeVersion ?? 'unknown'}`,
    `Runtime: ${context.platform}-${context.arch}, Node ${context.nodeVersion}`,
    `Diagnostics: ${context.settings.enabled ? 'enabled' : 'disabled'}, maxEvents=${context.settings.maxEvents}, redaction=${context.settings.redactionMode}`,
    '',
    '## Log and Storage Locations',
  ];

  if (context.locations.length === 0) {
    lines.push('- none reported');
  } else {
    for (const location of context.locations) {
      lines.push(`- ${location.label}: ${fingerprintDiagnosticPath(location.path)}`);
    }
  }

  lines.push('', '## Recent Extension Errors');
  if (failures.length === 0) {
    lines.push('- none recorded');
  } else {
    for (const event of failures.slice(-10)) {
      lines.push(`- #${event.sequence} ${event.category}/${event.name} ${event.wallClockTime}`);
    }
  }

  lines.push('', '## Notes');
  const notes = context.notes ?? [];
  if (notes.length === 0) {
    lines.push('- Remote helper logs are available through the PocketShell logs commands when the helper is installed on a connected host.');
  } else {
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push('', '## Events JSONL', JSON.stringify(summary));
  for (const event of events) {
    lines.push(JSON.stringify(event));
  }
  return `${lines.join('\n')}\n`;
}

function isRecentErrorEvent(event: DiagnosticEvent): boolean {
  return /fail|error|crash|exception|rejection/i.test(event.name);
}
