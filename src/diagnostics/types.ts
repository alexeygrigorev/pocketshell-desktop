export type DiagnosticCategory =
  | 'app'
  | 'navigation'
  | 'ssh'
  | 'tmux'
  | 'helper'
  | 'action'
  | 'extension'
  | 'diagnostics';

export type DiagnosticsRedactionMode = 'strict' | 'balanced' | 'off';

export type DiagnosticMetadataValue =
  | string
  | number
  | boolean
  | null
  | DiagnosticMetadataValue[]
  | { [key: string]: DiagnosticMetadataValue };

export type DiagnosticMetadata = Record<string, DiagnosticMetadataValue>;

export interface DiagnosticEvent {
  sequence: number;
  wallClockTime: string;
  monotonicTimestampNanos: string;
  category: DiagnosticCategory;
  name: string;
  metadata: DiagnosticMetadata;
}

export interface DiagnosticRecordInput {
  category: DiagnosticCategory;
  name: string;
  metadata?: DiagnosticMetadata;
}

export interface DiagnosticsConfig {
  enabled: boolean;
  maxEvents: number;
  redactionMode: DiagnosticsRedactionMode;
}

export interface DiagnosticLocation {
  label: string;
  path: string;
}

export interface DiagnosticReportContext {
  appName: string;
  extensionVersion?: string;
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  vscodeVersion?: string;
  generatedAt?: Date;
  settings: DiagnosticsConfig;
  locations: DiagnosticLocation[];
  notes?: string[];
}
