/**
 * Types for the PocketShell logs viewer integration.
 */

/** Log severity level. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A single log entry from the remote agent. */
export interface LogEntry {
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Severity level. */
  level: LogLevel;
  /** Log message text. */
  message: string;
  /** Originating component name, if available. */
  source?: string;
  /** Arbitrary key-value metadata attached to the entry. */
  metadata?: Record<string, any>;
}

/** Filter parameters for querying logs. All fields are optional. */
export interface LogFilter {
  /** Only return entries at this severity level. */
  level?: LogLevel;
  /** Only return entries from this source/component. */
  source?: string;
  /** Only return entries at or after this timestamp (ms). */
  since?: number;
  /** Only return entries before this timestamp (ms). */
  until?: number;
  /** Only return entries whose message contains this text (case-insensitive). */
  search?: string;
}
