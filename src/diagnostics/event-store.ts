import type {
  DiagnosticEvent,
  DiagnosticRecordInput,
  DiagnosticsConfig,
} from './types';
import { redactDiagnosticString, redactDiagnosticMetadata } from './redaction';

export class DiagnosticsEventStore {
  private readonly events: DiagnosticEvent[] = [];
  private sequence = 0;
  private config: DiagnosticsConfig;

  constructor(config?: Partial<DiagnosticsConfig>) {
    this.config = normalizeConfig(config);
  }

  configure(config: Partial<DiagnosticsConfig>): void {
    this.config = normalizeConfig({ ...this.config, ...config });
    this.trim();
  }

  getConfig(): DiagnosticsConfig {
    return { ...this.config };
  }

  record(input: DiagnosticRecordInput): DiagnosticEvent | undefined {
    if (!this.config.enabled || this.config.maxEvents <= 0) {
      return undefined;
    }

    const event: DiagnosticEvent = {
      sequence: ++this.sequence,
      wallClockTime: new Date().toISOString(),
      monotonicTimestampNanos: monotonicTimestampNanos(),
      category: input.category,
      name: input.name,
      metadata: redactDiagnosticMetadata(input.metadata, this.config.redactionMode),
    };
    this.events.push(event);
    this.trim();
    return event;
  }

  clear(): void {
    this.events.length = 0;
  }

  list(): DiagnosticEvent[] {
    return this.events.map((event) => ({
      ...event,
      metadata: { ...event.metadata },
    }));
  }

  toJsonLines(): string {
    return this.events.map((event) => JSON.stringify(event)).join('\n');
  }

  private trim(): void {
    const overflow = this.events.length - this.config.maxEvents;
    if (overflow > 0) {
      this.events.splice(0, overflow);
    }
  }
}

export function normalizeDiagnosticError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    const topFrame = error.stack?.split('\n').slice(1).find((line) => line.trim().length > 0);
    return {
      errorName: error.name,
      message: redactDiagnosticString(error.message, 'balanced'),
      ...(topFrame ? { topFrame: redactDiagnosticString(topFrame.trim(), 'balanced') } : {}),
    };
  }
  return {
    errorName: typeof error,
    message: redactDiagnosticString(String(error), 'balanced'),
  };
}

function normalizeConfig(config: Partial<DiagnosticsConfig> | undefined): DiagnosticsConfig {
  const maxEvents = Math.max(0, Math.floor(config?.maxEvents ?? 500));
  return {
    enabled: config?.enabled ?? true,
    maxEvents,
    redactionMode: config?.redactionMode ?? 'balanced',
  };
}

function monotonicTimestampNanos(): string {
  if (typeof process.hrtime?.bigint === 'function') {
    return process.hrtime.bigint().toString();
  }
  return String(Date.now() * 1_000_000);
}
