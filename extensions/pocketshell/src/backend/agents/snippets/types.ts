/**
 * Persisted snippet/template library types.
 *
 * This module is deliberately VS Code agnostic so model behavior can be unit
 * tested from the root `src/` tree and mirrored into the extension backend.
 */

export type SnippetKind = 'snippet' | 'template';

export type SnippetScope =
  | { type: 'global' }
  | { type: 'host'; hostId: number };

/**
 * Parity note: the desktop's host identity is the numeric `host.id` returned
 * by `ConnectionService.getHosts()` (a stable FNV-1a hash of the SSH alias —
 * see `stableHostId()` in `ssh-host-resolver.ts`). It is therefore the same
 * stable identity the rest of the desktop keys on, just hashed to an int so
 * it slots into `ConnectionManager`. Snippet/CommandTemplate scopes use this
 * numeric host id everywhere; there is no separate string-identity layer in
 * the connection code path (`pickHost`/`resolveHostId`/`getOrConnect` all
 * trade in the numeric id). App-parity delta: the Android app has a single
 * active host, so its scope is implicit; the desktop keeps an explicit
 * global/host scope (including a global scope the app lacks).
 */

export interface SnippetEntry {
  id: string;
  name: string;
  prefix: string;
  body: string;
  kind: SnippetKind;
  scope: SnippetScope;
  description?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SnippetInput {
  id?: string;
  name?: string;
  prefix?: string;
  body?: string | string[];
  kind?: SnippetKind;
  scope?: SnippetScope | string;
  description?: string;
  tags?: string[] | string;
  createdAt?: number;
  updatedAt?: number;
}

export interface SnippetScopeFilter {
  hostId?: number;
  includeGlobal?: boolean;
}

export type SnippetRunScopeCheck =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'missing-host' | 'host-mismatch';
      expectedHostId: number;
      actualHostId?: number;
    };

export interface SnippetExpansionContext {
  variables?: Record<string, string | number | boolean | undefined>;
}

export interface SnippetPaletteCommandDescriptor {
  id: string;
  prefix: string;
  label: string;
  description: string;
  category: string;
  icon: string;
  snippetId: string;
}

// ---------------------------------------------------------------------------
// Command templates ("Macros") — app feature-parity (§5).
// One shell submission per line. `{{placeholder}}` expansion at insert time.
// ---------------------------------------------------------------------------

/**
 * A multi-line command template (the app's "Macro"). The `commands` string is
 * a newline-separated list of shell submissions — each line is sent as its own
 * submission (newline → `\r` on send, matching the Android app).
 */
export interface CommandTemplateEntry {
  id: string;
  name: string;
  /** Newline-separated shell submissions. */
  commands: string;
  scope: SnippetScope;
  description?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CommandTemplateInput {
  id?: string;
  name?: string;
  /** string | string[] — arrays are joined with `\n`. */
  commands?: string | string[];
  scope?: SnippetScope | string;
  description?: string;
  tags?: string[] | string;
  createdAt?: number;
  updatedAt?: number;
}

export interface CommandTemplateScopeFilter {
  hostId?: number;
  includeGlobal?: boolean;
}

export type CommandTemplateRunScopeCheck =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'missing-host' | 'host-mismatch';
      expectedHostId: number;
      actualHostId?: number;
    };
