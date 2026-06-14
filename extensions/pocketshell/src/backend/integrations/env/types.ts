/**
 * Types for the PocketShell environment variable management integration.
 *
 * Env vars can be scoped globally, per-project, or per-session.
 */

/** A single environment variable entry. */
export interface EnvVar {
  /** Variable name (e.g. "API_KEY"). */
  key: string;
  /** Variable value. */
  value: string;
  /** If true, the value should be masked in the UI. */
  isSecret: boolean;
  /** Optional human-readable description. */
  description?: string;
}

/** Configuration container for a set of env vars within a scope. */
export interface EnvConfig {
  /** The environment variables in this config. */
  vars: EnvVar[];
  /** Scope level for the variables. */
  scope: 'global' | 'project' | 'session';
  /** Identifier within the scope — project path or session ID. */
  scopeId?: string;
}
