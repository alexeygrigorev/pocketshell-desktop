/**
 * Core types for the PocketShell VS Code settings model.
 *
 * Pure, vscode-free. Defines the configurable surface that the dedicated
 * PocketShell Settings view reads and writes through a `ConfigStore` adapter.
 *
 * These keys back a future `contributes.configuration` block under the
 * `pocketshell.*` namespace. They intentionally do NOT collide with the
 * file-backed AppSettings in `src/app/settings.ts` (`~/.pocketshell/settings.json`),
 * which stores host/session runtime state. This module covers editor-level
 * preferences surfaced in the dedicated settings view.
 */

/** Setting value kinds supported by the view controls. */
export type SettingType = 'boolean' | 'number' | 'string' | 'enum';

/** A single primitive value (enums are represented as string literals). */
export type SettingValue = boolean | number | string;

/** Logical grouping shown as sections in the settings view. */
export type SettingCategory =
  | 'terminal'
  | 'tmux'
  | 'cli'
  | 'connection'
  | 'diagnostics';

/** A documented, validated setting entry. */
export interface SettingDefinition {
  /** Dotted config key, relative to the `pocketshell.` scope. */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Short help text / tooltip. */
  description: string;
  /** Value kind; drives the rendered control. */
  type: SettingType;
  /** Section the setting is rendered under. */
  category: SettingCategory;
  /** Default applied when the key is absent. */
  defaultValue: SettingValue;
  /** Allowed enum values (required when type === 'enum'). */
  enumValues?: string[];
  /** Numeric bounds (applied when type === 'number'). */
  min?: number;
  /** Numeric bounds (applied when type === 'number'). */
  max?: number;
}

/**
 * Minimal read/write surface over a scoped configuration source.
 *
 * Implemented for VS Code (`vscode.workspace.getConfiguration('pocketshell')`)
 * in the feature provider, and faked in unit tests. Keeping this interface
 * vscode-free is what lets the pure logic be unit-tested without importing
 * the `vscode` module.
 */
export interface ConfigStore {
  /** True when `key` has an explicit user/workspace value. */
  has(key: string): boolean;
  /** Read `key`, returning `undefined` when unset. */
  get<T extends SettingValue>(key: string): T | undefined;
  /** Write `value` to `key` at the given target. */
  update(key: string, value: SettingValue): Thenable<void>;
}

/** Where an update is persisted. Mirrors vscode ConfigurationTarget. */
export enum ConfigTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

/** Result of validating a candidate value against a definition. */
export interface ValidationResult {
  ok: boolean;
  /** Human-readable reason when `ok === false`. */
  error?: string;
}
