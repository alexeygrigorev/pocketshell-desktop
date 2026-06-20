/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure state + HTML render for the Snippets library webview panel. Feature
 * parity with the PocketShell Android Snippets screen (app §5): three tabs
 * (Prompts / Commands / Macros), search, per-row Send / Send+Enter chips
 * with a body preview, and visual CRUD (add / edit / rename / delete).
 *
 * The desktop persists two kinds of snippet entries (`snippet` | `template`)
 * plus a separate CommandTemplate ("macro") collection. The persisted kinds
 * are mapped to the app's tab semantics in the panel UI only — kind is NOT
 * renamed on disk (see orchestrator decision #3).
 *
 * Kept free of vscode imports so it is unit-testable in isolation.
 */

import type {
  CommandTemplateEntry,
  SnippetEntry,
  SnippetKind,
  SnippetScope,
} from '../../agents/snippets/types';
import { scopeLabel } from '../../agents/snippets/model';

/** Panel tab — mirrors the app's Prompts / Commands / Macros tabs. */
export type SnippetsPanelTab = 'prompts' | 'commands' | 'macros';

export type SnippetsPanelTone = 'muted' | 'info' | 'success' | 'warning' | 'error';

/**
 * Desktop kind → app tab mapping.
 * - `template` (command template snippet) → Commands tab
 * - `snippet` (free-form text)            → Prompts tab
 * (Macros tab is driven by CommandTemplateEntry, not SnippetKind.)
 */
export function kindToTab(kind: SnippetKind): SnippetsPanelTab {
  return kind === 'template' ? 'commands' : 'prompts';
}

export interface SnippetsPanelScopeDescriptor {
  /** Stable host id when host-scoped, else undefined for global. */
  hostId?: number;
  /** Human-readable label, e.g. "Global" or "Host 3 (web-prod)". */
  label: string;
}

export interface SnippetsPanelSnippetRow {
  rowId: string;
  id: string;
  name: string;
  prefix: string;
  /** Single-line preview of the body (truncated). */
  preview: string;
  kind: SnippetKind;
  tab: SnippetsPanelTab;
  scopeLabel: string;
  description?: string;
  tags: string[];
  /** True when the row's body contains {{placeholder}} names. */
  hasPlaceholders: boolean;
}

export interface SnippetsPanelMacroRow {
  rowId: string;
  id: string;
  name: string;
  /** Number of command lines (submissions). */
  lineCount: number;
  /** Single-line preview of the first command. */
  preview: string;
  scopeLabel: string;
  description?: string;
  tags: string[];
  hasPlaceholders: boolean;
}

export interface SnippetsPanelModel {
  title: string;
  /** Active tab. */
  tab: SnippetsPanelTab;
  /** Active search query (empty string = no filter). */
  search: string;
  /** Scope the panel is currently filtering to (undefined = all scopes). */
  scope?: SnippetsPanelScopeDescriptor;
  promptRows: SnippetsPanelSnippetRow[];
  commandRows: SnippetsPanelSnippetRow[];
  macroRows: SnippetsPanelMacroRow[];
  /** Count badges per tab (pre-search, for the tab labels). */
  counts: { prompts: number; commands: number; macros: number };
  /** Status banner, if any. */
  status?: { tone: SnippetsPanelTone; message: string };
  emptyText: string;
}

export interface SnippetsPanelStateInput {
  snippets: readonly SnippetEntry[];
  macros: readonly CommandTemplateEntry[];
  tab?: SnippetsPanelTab;
  search?: string;
  scope?: SnippetsPanelScopeDescriptor;
  status?: { tone: SnippetsPanelTone; message: string };
}

/**
 * Build the panel model from raw snippet + macro libraries. Pure function.
 * Rows are filtered by the active tab + search query; counts are pre-search.
 */
export function buildSnippetsPanelModel(input: SnippetsPanelStateInput): SnippetsPanelModel {
  const tab = input.tab ?? 'prompts';
  const search = (input.search ?? '').trim().toLowerCase();

  const promptRowsAll: SnippetsPanelSnippetRow[] = [];
  const commandRowsAll: SnippetsPanelSnippetRow[] = [];
  for (const snippet of input.snippets) {
    const row = snippetToRow(snippet);
    if (row.tab === 'commands') {
      commandRowsAll.push(row);
    } else {
      promptRowsAll.push(row);
    }
  }
  const macroRowsAll: SnippetsPanelMacroRow[] = input.macros.map(macroToRow);

  const promptRows = filterSnippetRows(promptRowsAll, search);
  const commandRows = filterSnippetRows(commandRowsAll, search);
  const macroRows = filterMacroRows(macroRowsAll, search);

  const activeEmpty = computeEmptyText(tab, search);

  return {
    title: 'Snippets',
    tab,
    search: input.search ?? '',
    scope: input.scope,
    // Keep all three filtered lists populated so the webview JS can switch
    // tabs without a round-trip; only the active tab is rendered server-side.
    promptRows,
    commandRows,
    macroRows,
    counts: {
      prompts: promptRowsAll.length,
      commands: commandRowsAll.length,
      macros: macroRowsAll.length,
    },
    status: input.status,
    emptyText: activeEmpty,
  };
}

function snippetToRow(snippet: SnippetEntry): SnippetsPanelSnippetRow {
  return {
    rowId: snippet.id,
    id: snippet.id,
    name: snippet.name,
    prefix: snippet.prefix,
    preview: previewText(snippet.body),
    kind: snippet.kind,
    tab: kindToTab(snippet.kind),
    scopeLabel: scopeLabel(snippet.scope),
    description: snippet.description,
    tags: snippet.tags,
    hasPlaceholders: /\{\{\s*[A-Za-z][\w-]{0,39}\s*\}\}/.test(snippet.body),
  };
}

function macroToRow(macro: CommandTemplateEntry): SnippetsPanelMacroRow {
  const lines = macro.commands.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  return {
    rowId: macro.id,
    id: macro.id,
    name: macro.name,
    lineCount: lines.length,
    preview: previewText(lines[0] ?? macro.commands),
    scopeLabel: scopeLabel(macro.scope),
    description: macro.description,
    tags: macro.tags,
    hasPlaceholders: /\{\{\s*[A-Za-z][\w-]{0,39}\s*\}\}/.test(macro.commands),
  };
}

function filterSnippetRows(rows: readonly SnippetsPanelSnippetRow[], search: string): SnippetsPanelSnippetRow[] {
  if (!search) {
    return [...rows];
  }
  return rows.filter((row) => rowMatches(row.name, row.prefix, row.preview, row.description, row.tags, search));
}

function filterMacroRows(rows: readonly SnippetsPanelMacroRow[], search: string): SnippetsPanelMacroRow[] {
  if (!search) {
    return [...rows];
  }
  return rows.filter((row) => rowMatches(row.name, '', row.preview, row.description, row.tags, search));
}

function rowMatches(
  name: string,
  prefix: string,
  preview: string,
  description: string | undefined,
  tags: readonly string[],
  search: string,
): boolean {
  if (name.toLowerCase().includes(search)) return true;
  if (prefix && prefix.toLowerCase().includes(search)) return true;
  if (preview.toLowerCase().includes(search)) return true;
  if (description && description.toLowerCase().includes(search)) return true;
  if (tags.some((tag) => tag.includes(search))) return true;
  return false;
}

function previewText(body: string): string {
  const firstLine = body.replace(/\r\n?/g, '\n').split('\n')[0] ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function computeEmptyText(tab: SnippetsPanelTab, search: string): string {
  if (search) {
    return `No ${tab} match "${search}".`;
  }
  const label = tab === 'macros' ? 'macros' : tab;
  return `No ${label} yet. Add one below.`;
}

export function scopeDescriptorFor(scope: SnippetScope, hostName?: string): SnippetsPanelScopeDescriptor {
  if (scope.type === 'global') {
    return { label: 'Global' };
  }
  return {
    hostId: scope.hostId,
    label: hostName ? `Host ${hostName}` : scopeLabel(scope),
  };
}

export interface SnippetsPanelHtmlOptions {
  cspSource?: string;
  nonce?: string;
}

/**
 * Render the full HTML document for the Snippets webview panel. Pure function.
 * Relies on `acquireVsCodeApi()` for actions: switchTab, search, send,
 * sendEnter, edit, delete, add.
 */
export function renderSnippetsPanelHtml(
  model: SnippetsPanelModel,
  options: SnippetsPanelHtmlOptions = {},
): string {
  const nonceAttribute = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
  const csp = renderSnippetsContentSecurityPolicy(options);
  const cspMeta = csp
    ? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">\n`
    : '';
  const promptRowsJson = jsonForScript(model.promptRows);
  const commandRowsJson = jsonForScript(model.commandRows);
  const macroRowsJson = jsonForScript(model.macroRows);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta}<meta name="viewport" content="width=device-width, initial-scale=1">
<style${nonceAttribute}>
:root { color-scheme: light dark; }
body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.panel { box-sizing: border-box; min-height: 100vh; display: grid; grid-template-rows: auto auto auto 1fr; }
.header { display: flex; align-items: baseline; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
.title { font-weight: 600; }
.subtitle { color: var(--vscode-descriptionForeground); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
.toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-left: auto; }
.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--vscode-panel-border); padding: 0 14px; }
.tab { background: transparent; color: var(--vscode-descriptionForeground); border: 0; border-bottom: 2px solid transparent; padding: 8px 12px; cursor: pointer; font: inherit; border-radius: 0; }
.tab:hover { color: var(--vscode-foreground); }
.tab[data-active="true"] { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
.tab .count { color: var(--vscode-descriptionForeground); font-size: 0.8em; margin-left: 5px; }
.search-bar { display: flex; gap: 8px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
.search-bar input { flex: 1; }
.content { padding: 12px 14px; overflow: auto; }
.status { margin-bottom: 10px; padding: 7px 9px; border-left: 3px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
.status[data-tone="success"] { border-left-color: var(--vscode-testing-iconPassed); }
.status[data-tone="error"] { border-left-color: var(--vscode-errorForeground); }
.status[data-tone="warning"] { border-left-color: var(--vscode-notificationsWarningIcon-foreground); }
.status[data-tone="info"] { border-left-color: var(--vscode-textLink-foreground); }
.empty { color: var(--vscode-descriptionForeground); padding: 16px 0; }
.rows { display: grid; gap: 8px; }
.row { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; background: var(--vscode-editorWidget-background); display: grid; grid-template-columns: 1fr auto; gap: 8px 10px; align-items: center; }
.row-head { min-width: 0; }
.row-title { font-weight: 600; overflow-wrap: anywhere; }
.row-title .fallback { color: var(--vscode-descriptionForeground); }
.preview { color: var(--vscode-descriptionForeground); font-size: 0.86em; font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-meta { color: var(--vscode-descriptionForeground); font-size: 0.82em; font-family: var(--vscode-editor-font-family); }
.tag { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 0.72em; font-weight: 600; text-transform: uppercase; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 4px; }
.ph-tag { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 0.72em; font-weight: 600; text-transform: uppercase; background: var(--vscode-inputValidation-infoBackground); color: var(--vscode-textLink-foreground); }
.row-actions { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 5px 9px; border-radius: 4px; cursor: pointer; white-space: nowrap; font: inherit; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.55; cursor: default; }
input { box-sizing: border-box; width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 5px 7px; border-radius: 4px; font: inherit; }
@media (max-width: 620px) {
  .row { grid-template-columns: 1fr; }
  .row-actions { justify-content: flex-start; }
}
</style>
</head>
<body>
<section class="panel" aria-label="PocketShell snippets">
  <header class="header">
    <div class="title">Snippets</div>
    <div class="subtitle">${escapeHtml(model.scope?.label ?? 'All scopes')}</div>
    <div class="toolbar">
      <button type="button" data-action="refresh">Refresh</button>
      <button type="button" data-action="add" data-tab="${escapeHtml(model.tab)}">Add</button>
    </div>
  </header>
  <nav class="tabs" role="tablist">
    <button type="button" class="tab" role="tab" data-tab="prompts" data-active="${String(model.tab === 'prompts')}">Prompts<span class="count">${String(model.counts.prompts)}</span></button>
    <button type="button" class="tab" role="tab" data-tab="commands" data-active="${String(model.tab === 'commands')}">Commands<span class="count">${String(model.counts.commands)}</span></button>
    <button type="button" class="tab" role="tab" data-tab="macros" data-active="${String(model.tab === 'macros')}">Macros<span class="count">${String(model.counts.macros)}</span></button>
  </nav>
  <form class="search-bar" data-search-form>
    <input name="search" placeholder="Search snippets, commands, macros…" value="${escapeHtml(model.search)}" autocomplete="off">
    <button type="submit" class="secondary">Search</button>
  </form>
  <main class="content">
    ${model.status ? `<div class="status" role="status" data-tone="${escapeHtml(model.status.tone)}">${escapeHtml(model.status.message)}</div>` : ''}
    ${renderActiveList(model)}
  </main>
</section>
<script${nonceAttribute}>
const vscode = acquireVsCodeApi();
const promptRows = ${promptRowsJson};
const commandRows = ${commandRowsJson};
const macroRows = ${macroRowsJson};
let activeTab = ${jsonForScript(model.tab)};

function rowsFor(tab) {
  if (tab === 'prompts') return promptRows;
  if (tab === 'commands') return commandRows;
  return macroRows;
}
function findRow(id) {
  return rowsFor(activeTab).find((row) => row.rowId === id);
}
document.querySelector('[data-search-form]')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  vscode.postMessage({ action: 'search', search: form.elements.search.value });
});
document.querySelector('[data-search-form] input[name="search"]')?.addEventListener('input', (event) => {
  vscode.postMessage({ action: 'search', search: event.currentTarget.value });
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action], button.tab');
  if (!button) return;
  if (button.classList.contains('tab')) {
    const tab = button.dataset.tab;
    if (tab && tab !== activeTab) {
      activeTab = tab;
      vscode.postMessage({ action: 'switchTab', tab });
    }
    return;
  }
  const action = button.dataset.action;
  if (action === 'refresh') {
    vscode.postMessage({ action: 'refresh' });
    return;
  }
  if (action === 'add') {
    vscode.postMessage({ action: 'add', tab: button.dataset.tab || activeTab });
    return;
  }
  const rowId = button.closest('[data-row-id]')?.dataset.rowId;
  const row = rowId ? findRow(rowId) : undefined;
  if (!row) return;
  if (action === 'send') {
    vscode.postMessage({ action: 'send', id: row.id, submit: false, kind: activeTab === 'macros' ? 'macro' : 'snippet' });
    return;
  }
  if (action === 'sendEnter') {
    vscode.postMessage({ action: 'send', id: row.id, submit: true, kind: activeTab === 'macros' ? 'macro' : 'snippet' });
    return;
  }
  if (action === 'edit') {
    vscode.postMessage({ action: 'edit', id: row.id, kind: activeTab === 'macros' ? 'macro' : 'snippet' });
    return;
  }
  if (action === 'delete') {
    if (window.confirm('Delete ' + row.name + '?')) {
      vscode.postMessage({ action: 'delete', id: row.id, kind: activeTab === 'macros' ? 'macro' : 'snippet' });
    }
  }
});
window.dispatchEvent(new Event('snippets:ready'));
</script>
</body>
</html>`;
}

function renderActiveList(model: SnippetsPanelModel): string {
  if (model.tab === 'macros') {
    return model.macroRows.length === 0
      ? `<div class="empty">${escapeHtml(model.emptyText)}</div>`
      : `<div class="rows">${model.macroRows.map(renderMacroRow).join('')}</div>`;
  }
  const rows = model.tab === 'commands' ? model.commandRows : model.promptRows;
  return rows.length === 0
    ? `<div class="empty">${escapeHtml(model.emptyText)}</div>`
    : `<div class="rows">${rows.map(renderSnippetRow).join('')}</div>`;
}

function renderSnippetRow(row: SnippetsPanelSnippetRow): string {
  return `<article class="row" data-row-id="${escapeHtml(row.rowId)}">
  <div class="row-head">
    <div class="row-title">${escapeHtml(row.name) || `<span class="fallback">/${escapeHtml(row.prefix)}</span>`}${row.hasPlaceholders ? ' <span class="ph-tag">placeholders</span>' : ''}</div>
    <div class="preview">${escapeHtml(row.preview) || `<span class="fallback">/${escapeHtml(row.prefix)}</span>`}</div>
    <div class="row-meta">${escapeHtml(row.scopeLabel)}${row.description ? ` · ${escapeHtml(row.description)}` : ''}${row.tags.length > 0 ? ` · ${row.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}` : ''}</div>
  </div>
  <div class="row-actions">
    <button type="button" data-action="send" title="Insert into pane (no Enter)">Send</button>
    <button type="button" data-action="sendEnter" title="Send + Enter">Send+Enter</button>
    <button type="button" class="secondary" data-action="edit" title="Edit">Edit</button>
    <button type="button" class="secondary" data-action="delete" title="Delete">Delete</button>
  </div>
</article>`;
}

function renderMacroRow(row: SnippetsPanelMacroRow): string {
  return `<article class="row" data-row-id="${escapeHtml(row.rowId)}">
  <div class="row-head">
    <div class="row-title">${escapeHtml(row.name)}${row.hasPlaceholders ? ' <span class="ph-tag">placeholders</span>' : ''}</div>
    <div class="preview">${escapeHtml(row.preview)}</div>
    <div class="row-meta">${escapeHtml(row.scopeLabel)} · ${escapeHtml(String(row.lineCount))} line(s)${row.description ? ` · ${escapeHtml(row.description)}` : ''}</div>
  </div>
  <div class="row-actions">
    <button type="button" data-action="send" title="Insert lines (no Enter)">Send</button>
    <button type="button" data-action="sendEnter" title="Send each line + Enter">Send+Enter</button>
    <button type="button" class="secondary" data-action="edit" title="Edit">Edit</button>
    <button type="button" class="secondary" data-action="delete" title="Delete">Delete</button>
  </div>
</article>`;
}

function renderSnippetsContentSecurityPolicy(options: SnippetsPanelHtmlOptions): string {
  const cspSource = options.cspSource ?? '';
  const parts = [
    "default-src 'none'",
    `img-src ${cspSource} https: data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
  ];
  if (options.nonce) {
    parts.push(`script-src 'nonce-${options.nonce}'`);
  } else {
    parts.push(`script-src ${cspSource}`);
  }
  return parts.join('; ');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
