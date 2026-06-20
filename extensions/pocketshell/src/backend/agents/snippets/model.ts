import type {
  CommandTemplateEntry,
  CommandTemplateInput,
  CommandTemplateRunScopeCheck,
  CommandTemplateScopeFilter,
  SnippetEntry,
  SnippetExpansionContext,
  SnippetInput,
  SnippetKind,
  SnippetPaletteCommandDescriptor,
  SnippetRunScopeCheck,
  SnippetScope,
  SnippetScopeFilter,
} from './types';

export const SNIPPET_LIBRARY_STATE_KEY = 'pocketshell.snippets.library';

export class SnippetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnippetValidationError';
  }
}

export function normalizeSnippet(input: SnippetInput, existing?: SnippetEntry, now = Date.now()): SnippetEntry {
  const name = normalizeRequiredText(input.name ?? existing?.name, 'Snippet name');
  const prefix = normalizePrefix(input.prefix ?? existing?.prefix ?? name);
  const body = normalizeRequiredText(normalizeBodyInput(input.body ?? existing?.body), 'Snippet body');
  const kind = normalizeKind(input.kind ?? existing?.kind ?? 'snippet');
  const scope = normalizeScope(input.scope ?? existing?.scope ?? { type: 'global' });
  const description = normalizeOptionalText(input.description ?? existing?.description);
  const tags = normalizeTags(input.tags ?? existing?.tags ?? []);
  const createdAt = normalizeTimestamp(input.createdAt ?? existing?.createdAt ?? now, now);
  const updatedAt = normalizeTimestamp(input.updatedAt ?? now, now);
  const id = normalizeId(input.id ?? existing?.id ?? createSnippetId(prefix, now));

  return {
    id,
    name,
    prefix,
    body,
    kind,
    scope,
    ...(description ? { description } : {}),
    tags,
    createdAt,
    updatedAt,
  };
}

export function validateSnippet(snippet: SnippetEntry): SnippetEntry {
  return normalizeSnippet(snippet, undefined, snippet.updatedAt);
}

export function parseSnippetLibrary(raw: unknown): SnippetEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const snippets: SnippetEntry[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!isRecord(value)) {
      continue;
    }
    try {
      const snippet = normalizeSnippet(value as SnippetInput);
      if (seen.has(snippet.id)) {
        continue;
      }
      seen.add(snippet.id);
      snippets.push(snippet);
    } catch {
      // Ignore corrupt persisted entries so one bad record does not hide the library.
    }
  }
  return sortSnippets(snippets);
}

export function upsertSnippet(library: readonly SnippetEntry[], input: SnippetInput, now = Date.now()): SnippetEntry[] {
  const id = typeof input.id === 'string' ? normalizeId(input.id) : undefined;
  const existing = id ? library.find((snippet) => snippet.id === id) : undefined;
  const next = normalizeSnippet(input, existing, now);
  const withoutExisting = library.filter((snippet) => snippet.id !== next.id);
  return sortSnippets([...withoutExisting, next]);
}

export function deleteSnippet(library: readonly SnippetEntry[], snippetId: string): SnippetEntry[] {
  const id = normalizeId(snippetId);
  return library.filter((snippet) => snippet.id !== id);
}

export function getSnippet(library: readonly SnippetEntry[], snippetId: string): SnippetEntry | undefined {
  const id = normalizeId(snippetId);
  return library.find((snippet) => snippet.id === id);
}

export function filterSnippetsByScope(
  library: readonly SnippetEntry[],
  filter: SnippetScopeFilter = {},
): SnippetEntry[] {
  const includeGlobal = filter.includeGlobal !== false;
  return sortSnippets(library.filter((snippet) => {
    if (snippet.scope.type === 'global') {
      return includeGlobal;
    }
    return filter.hostId !== undefined && snippet.scope.hostId === filter.hostId;
  }));
}

export function checkSnippetRunScope(snippet: SnippetEntry, hostId: number | undefined): SnippetRunScopeCheck {
  if (snippet.scope.type === 'global') {
    return { allowed: true };
  }
  if (hostId === undefined) {
    return {
      allowed: false,
      reason: 'missing-host',
      expectedHostId: snippet.scope.hostId,
    };
  }
  if (hostId !== snippet.scope.hostId) {
    return {
      allowed: false,
      reason: 'host-mismatch',
      expectedHostId: snippet.scope.hostId,
      actualHostId: hostId,
    };
  }
  return { allowed: true };
}

export function expandSnippetBody(
  snippet: Pick<SnippetEntry, 'body'>,
  context: SnippetExpansionContext = {},
): string {
  const variables = context.variables ?? {};
  return snippet.body
    .replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (_match, key: string) => stringifyVariable(variables[key]))
    .replace(/\$\{(\d+):([^}]*)\}/g, (_match, _index: string, fallback: string) => fallback)
    .replace(/\$\{(\d+)\}/g, '')
    .replace(/\$(\d+)/g, '')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (match, key: string) => {
      const value = variables[key];
      return value === undefined ? match : stringifyVariable(value);
    });
}

/**
 * Placeholder pattern — app feature-parity §5: `\{\{\s*([A-Za-z][\w-]{0,39})\s*\}\}`.
 * Names start with a letter and may contain word chars/dashes, up to 40 chars.
 */
export const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][\w-]{0,39})\s*\}\}/g;

/**
 * Extract the unique placeholder names (`{{name}}`) from a snippet/template
 * body or macro command list, in first-occurrence order. Used to drive the
 * per-placeholder insert dialog (app shows an AlertDialog per placeholder).
 */
export function extractPlaceholderNames(body: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Resolve placeholders in a body using a per-name value map. Unresolved
 * placeholders are left intact (so the user can retry). Built on top of the
 * existing `expandSnippetBody` engine — variables map keyed by placeholder
 * name.
 */
export function resolvePlaceholders(
  body: string,
  values: Record<string, string | number | boolean | undefined>,
): string {
  return expandSnippetBody({ body }, { variables: values });
}

export function snippetToPaletteCommand(snippet: SnippetEntry): SnippetPaletteCommandDescriptor {
  const scopeLabel = snippet.scope.type === 'host' ? `host ${snippet.scope.hostId}` : 'global';
  const tags = snippet.tags.length > 0 ? ` (${snippet.tags.join(', ')})` : '';
  const description = snippet.description
    ? `${snippet.description} - ${scopeLabel}${tags}`
    : `${snippet.kind} - ${scopeLabel}${tags}`;
  return {
    id: snippetPaletteCommandId(snippet.id),
    prefix: `/${normalizePrefix(snippet.prefix)}`,
    label: snippet.name,
    description,
    category: 'Snippets',
    icon: '$(symbol-snippet)',
    snippetId: snippet.id,
  };
}

export function snippetPaletteCommandId(snippetId: string): string {
  return `pocketshell.snippets.run.${normalizeId(snippetId)}`;
}

export function createSnippetId(prefix: string, now = Date.now()): string {
  return `${normalizePrefix(prefix)}-${Math.max(0, Math.floor(now)).toString(36)}`;
}

export function scopeLabel(scope: SnippetScope): string {
  return scope.type === 'host' ? `Host ${scope.hostId}` : 'Global';
}

// ---------------------------------------------------------------------------
// Command templates ("Macros") — app feature-parity §5.
// ---------------------------------------------------------------------------

export const COMMAND_TEMPLATE_LIBRARY_STATE_KEY = 'pocketshell.snippets.commandTemplates';

export function normalizeCommandTemplate(
  input: CommandTemplateInput,
  existing?: CommandTemplateEntry,
  now = Date.now(),
): CommandTemplateEntry {
  const name = normalizeRequiredText(input.name ?? existing?.name, 'Command template name');
  const commandsRaw = normalizeCommandsInput(input.commands ?? existing?.commands);
  const commands = normalizeRequiredText(commandsRaw, 'Command template commands');
  const scope = normalizeScope(input.scope ?? existing?.scope ?? { type: 'global' });
  const description = normalizeOptionalText(input.description ?? existing?.description);
  const tags = normalizeTags(input.tags ?? existing?.tags ?? []);
  const createdAt = normalizeTimestamp(input.createdAt ?? existing?.createdAt ?? now, now);
  const updatedAt = normalizeTimestamp(input.updatedAt ?? now, now);
  const id = normalizeId(input.id ?? existing?.id ?? createSnippetId(name, now));

  return {
    id,
    name,
    commands,
    scope,
    ...(description ? { description } : {}),
    tags,
    createdAt,
    updatedAt,
  };
}

export function parseCommandTemplateLibrary(raw: unknown): CommandTemplateEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const templates: CommandTemplateEntry[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!isRecord(value)) {
      continue;
    }
    try {
      const template = normalizeCommandTemplate(value as CommandTemplateInput);
      if (seen.has(template.id)) {
        continue;
      }
      seen.add(template.id);
      templates.push(template);
    } catch {
      // Ignore corrupt persisted entries.
    }
  }
  return sortCommandTemplates(templates);
}

export function upsertCommandTemplate(
  library: readonly CommandTemplateEntry[],
  input: CommandTemplateInput,
  now = Date.now(),
): CommandTemplateEntry[] {
  const id = typeof input.id === 'string' ? normalizeId(input.id) : undefined;
  const existing = id ? library.find((t) => t.id === id) : undefined;
  const next = normalizeCommandTemplate(input, existing, now);
  const withoutExisting = library.filter((t) => t.id !== next.id);
  return sortCommandTemplates([...withoutExisting, next]);
}

export function deleteCommandTemplate(
  library: readonly CommandTemplateEntry[],
  id: string,
): CommandTemplateEntry[] {
  const normalized = normalizeId(id);
  return library.filter((t) => t.id !== normalized);
}

export function getCommandTemplate(
  library: readonly CommandTemplateEntry[],
  id: string,
): CommandTemplateEntry | undefined {
  const normalized = normalizeId(id);
  return library.find((t) => t.id === normalized);
}

export function filterCommandTemplatesByScope(
  library: readonly CommandTemplateEntry[],
  filter: CommandTemplateScopeFilter = {},
): CommandTemplateEntry[] {
  const includeGlobal = filter.includeGlobal !== false;
  return sortCommandTemplates(library.filter((template) => {
    if (template.scope.type === 'global') {
      return includeGlobal;
    }
    return filter.hostId !== undefined && template.scope.hostId === filter.hostId;
  }));
}

export function checkCommandTemplateRunScope(
  template: CommandTemplateEntry,
  hostId: number | undefined,
): CommandTemplateRunScopeCheck {
  if (template.scope.type === 'global') {
    return { allowed: true };
  }
  if (hostId === undefined) {
    return {
      allowed: false,
      reason: 'missing-host',
      expectedHostId: template.scope.hostId,
    };
  }
  if (hostId !== template.scope.hostId) {
    return {
      allowed: false,
      reason: 'host-mismatch',
      expectedHostId: template.scope.hostId,
      actualHostId: hostId,
    };
  }
  return { allowed: true };
}

/**
 * Split a command template's commands into individual shell submissions
 * (one per non-empty line). Newlines map to `\r` on send, matching the app.
 */
export function splitCommandLines(commands: string): string[] {
  return commands
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Expand a command template's lines, applying placeholder values to each line.
 * Returns one expanded submission per non-empty line.
 */
export function expandCommandTemplateLines(
  template: Pick<CommandTemplateEntry, 'commands'>,
  values: Record<string, string | number | boolean | undefined> = {},
): string[] {
  return splitCommandLines(template.commands).map((line) => resolvePlaceholders(line, values));
}

function sortCommandTemplates(templates: readonly CommandTemplateEntry[]): CommandTemplateEntry[] {
  return [...templates].sort((a, b) => {
    const scopeCmp = scopeLabel(a.scope).localeCompare(scopeLabel(b.scope));
    if (scopeCmp !== 0) return scopeCmp;
    return a.name.localeCompare(b.name);
  });
}

function normalizeCommandsInput(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.join('\n');
  }
  return value;
}

function sortSnippets(snippets: readonly SnippetEntry[]): SnippetEntry[] {
  return [...snippets].sort((a, b) => {
    const scopeCmp = scopeLabel(a.scope).localeCompare(scopeLabel(b.scope));
    if (scopeCmp !== 0) return scopeCmp;
    return a.name.localeCompare(b.name);
  });
}

function normalizeBodyInput(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.join('\n');
  }
  return value;
}

function normalizeRequiredText(value: string | undefined, field: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new SnippetValidationError(`${field} is required`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePrefix(value: string): string {
  const normalized = value
    .trim()
    .replace(/^\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
  if (!normalized) {
    throw new SnippetValidationError('Snippet prefix is required');
  }
  return normalized.slice(0, 80);
}

function normalizeId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.:-]+/, '')
    .replace(/[.:-]+$/, '');
  if (!normalized) {
    throw new SnippetValidationError('Snippet id is required');
  }
  return normalized.slice(0, 120);
}

function normalizeKind(value: SnippetKind): SnippetKind {
  if (value === 'snippet' || value === 'template') {
    return value;
  }
  throw new SnippetValidationError('Snippet kind must be snippet or template');
}

function normalizeScope(value: SnippetScope | string): SnippetScope {
  if (value === 'global') {
    return { type: 'global' };
  }
  if (isRecord(value)) {
    if (value.type === 'global') {
      return { type: 'global' };
    }
    if (value.type === 'host') {
      const hostId = Number(value.hostId);
      if (Number.isInteger(hostId) && hostId >= 0) {
        return { type: 'host', hostId };
      }
    }
  }
  throw new SnippetValidationError('Snippet scope must be global or a host id');
}

function normalizeTags(value: string[] | string): string[] {
  const raw = Array.isArray(value) ? value : value.split(',');
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of raw) {
    const normalized = tag.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

function normalizeTimestamp(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Math.floor(fallback);
}

function stringifyVariable(value: string | number | boolean | undefined): string {
  return value === undefined ? '' : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
