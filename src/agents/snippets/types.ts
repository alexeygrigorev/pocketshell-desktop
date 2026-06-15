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
