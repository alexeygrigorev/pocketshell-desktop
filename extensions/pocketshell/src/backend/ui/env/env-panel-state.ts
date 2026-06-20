/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure state + HTML render for the Env management webview panel. Feature parity
 * with the PocketShell Android Env screen: per-folder key/value table, masked
 * secret values with reveal-on-tap, and create/update/copy actions.
 *
 * Kept free of vscode imports so it is unit-testable in isolation.
 */

import type { EnvCopyDestination, EnvVar } from '../../integrations/env/types';
import { safeEnvValue } from '../../integrations/env/env-client';

export type EnvPanelTone = 'muted' | 'info' | 'success' | 'warning' | 'error';

export interface EnvPanelRow {
	/** Stable key for React-style keyed rendering. */
	rowId: string;
	/** Variable name. */
	key: string;
	/** Masked value for display (e.g. "***" for secrets). */
	maskedValue: string;
	/** True when the underlying value is a secret and must be masked by default. */
	isSecret: boolean;
	/** Optional human-readable description. */
	description?: string;
}

export interface EnvPanelModel {
	title: string;
	scope: string;
	hostName: string;
	rows: EnvPanelRow[];
	/** Folders the entries can be copied to (excludes the current scope). */
	copyDestinations: Array<{ label: string; path: string }>;
	/** Status banner, if any. */
	status?: { tone: EnvPanelTone; message: string };
	/** True while a load/mutation is in flight. */
	loading: boolean;
	/** Whether the underlying SSH connection is live. */
	connected: boolean;
	emptyText: string;
}

export interface EnvPanelStateInput {
	scope: string;
	hostName: string;
	vars: readonly EnvVar[];
	copyDestinations: readonly EnvCopyDestination[];
	connected: boolean;
	loading?: boolean;
	status?: { tone: EnvPanelTone; message: string };
}

/**
 * Build the panel model from raw env vars + folder list. Pure function.
 */
export function buildEnvPanelModel(input: EnvPanelStateInput): EnvPanelModel {
	const rows: EnvPanelRow[] = [...input.vars]
		.sort((a, b) => a.key.localeCompare(b.key))
		.map((entry) => ({
			rowId: entry.key,
			key: entry.key,
			maskedValue: safeEnvValue(entry),
			isSecret: entry.isSecret,
			description: entry.description,
		}));

	const destinations = input.copyDestinations
		.filter((folder) => folder.enabled && folder.path !== input.scope)
		.map((folder) => ({ label: folder.label, path: folder.path }));

	return {
		title: `Env — ${input.scope}`,
		scope: input.scope,
		hostName: input.hostName,
		rows,
		copyDestinations: destinations,
		status: input.status,
		loading: input.loading ?? false,
		connected: input.connected,
		emptyText: rows.length === 0
			? 'No environment variables in this folder yet. Add one below.'
			: '',
	};
}

export interface EnvPanelHtmlOptions {
	cspSource?: string;
	nonce?: string;
}

/**
 * Render the full HTML document for the Env webview panel. Pure function.
 * Relies on `acquireVsCodeApi()` for actions: reveal, create, update, copy.
 */
export function renderEnvPanelHtml(
	model: EnvPanelModel,
	options: EnvPanelHtmlOptions = {},
): string {
	const nonceAttribute = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
	const csp = renderEnvContentSecurityPolicy(options);
	const cspMeta = csp
		? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">\n`
		: '';
	const rowsJson = jsonForScript(model.rows);
	const destinationsJson = jsonForScript(model.copyDestinations);

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta}<meta name="viewport" content="width=device-width, initial-scale=1">
<style${nonceAttribute}>
:root { color-scheme: light dark; }
body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.panel { box-sizing: border-box; min-height: 100vh; display: grid; grid-template-rows: auto auto 1fr; }
.header { display: flex; align-items: baseline; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
.title { font-weight: 600; }
.subtitle { color: var(--vscode-descriptionForeground); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
.toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-left: auto; }
.content { padding: 12px 14px; overflow: auto; }
.status { margin-bottom: 10px; padding: 7px 9px; border-left: 3px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
.status[data-tone="success"] { border-left-color: var(--vscode-testing-iconPassed); }
.status[data-tone="error"] { border-left-color: var(--vscode-errorForeground); }
.status[data-tone="warning"] { border-left-color: var(--vscode-notificationsWarningIcon-foreground); }
.status[data-tone="info"] { border-left-color: var(--vscode-textLink-foreground); }
.empty { color: var(--vscode-descriptionForeground); padding: 16px 0; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; vertical-align: middle; }
th { color: var(--vscode-descriptionForeground); font-weight: 500; }
.key { font-weight: 600; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
.value { font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
.value.muted { color: var(--vscode-descriptionForeground); }
.description { color: var(--vscode-descriptionForeground); font-size: 0.86em; }
.secret-tag { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 0.72em; font-weight: 600; text-transform: uppercase; background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-notificationsWarningIcon-foreground); }
button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 5px 9px; border-radius: 4px; cursor: pointer; white-space: nowrap; font: inherit; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.icon { min-width: 28px; padding-inline: 7px; }
button:disabled { opacity: 0.55; cursor: default; }
.row-actions { display: flex; gap: 5px; flex-wrap: wrap; }
.add-bar { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(160px, 1.5fr) auto; gap: 8px; align-items: end; padding: 12px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
.add-bar label { display: grid; gap: 4px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
input { box-sizing: border-box; width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 5px 7px; border-radius: 4px; font: inherit; }
.disconnected { color: var(--vscode-errorForeground); font-size: 0.86em; }
@media (max-width: 620px) {
  .add-bar { grid-template-columns: 1fr; }
  table, thead, tbody, tr, th, td { display: block; }
  thead { display: none; }
  tr { border-bottom: 1px solid var(--vscode-panel-border); padding: 8px 0; }
  td { border-bottom: 0; padding: 4px 0; }
}
</style>
</head>
<body>
<section class="panel" aria-label="PocketShell env">
  <header class="header">
    <div class="title">Env</div>
    <div class="subtitle">${escapeHtml(model.scope)}</div>
    <div class="toolbar">
      ${model.connected ? '' : '<span class="disconnected">disconnected</span>'}
      <button type="button" data-action="refresh">Refresh</button>
      <button type="button" data-action="copy" ${model.copyDestinations.length === 0 || model.rows.length === 0 ? 'disabled' : ''}>Copy to folder…</button>
    </div>
  </header>
  <form class="add-bar" data-env-form>
    <label>Key<input name="key" placeholder="API_KEY" autocomplete="off"></label>
    <label>Value<input name="value" placeholder="secret-value" type="text"></label>
    <div><button type="submit">Add / Update</button></div>
  </form>
  <main class="content">
    ${model.status ? `<div class="status" role="status" data-tone="${escapeHtml(model.status.tone)}">${escapeHtml(model.status.message)}</div>` : ''}
    ${model.rows.length === 0
      ? `<div class="empty">${escapeHtml(model.emptyText)}</div>`
      : `<table>
      <thead><tr><th style="width: 30%">Key</th><th style="width: 45%">Value</th><th style="width: 25%">Actions</th></tr></thead>
      <tbody>
      ${model.rows.map(renderRow).join('')}
      </tbody>
    </table>`}
  </main>
</section>
<script${nonceAttribute}>
const vscode = acquireVsCodeApi();
const rows = ${rowsJson};
const destinations = ${destinationsJson};
const revealed = new Set();
function findRow(button) {
  const key = button.closest('[data-row-key]')?.dataset.rowKey;
  return rows.find((row) => row.rowId === key);
}
document.querySelector('[data-env-form]')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const key = form.elements.key.value.trim();
  const value = form.elements.value.value;
  if (!key) return;
  vscode.postMessage({ action: 'set', key, value });
  form.reset();
  form.elements.key.focus();
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'refresh') {
    vscode.postMessage({ action: 'refresh' });
    return;
  }
  if (action === 'copy') {
    if (destinations.length === 0) return;
    vscode.postMessage({ action: 'copy' });
    return;
  }
  const row = findRow(button);
  if (!row) return;
  if (action === 'reveal') {
    vscode.postMessage({ action: 'get', key: row.key });
    return;
  }
  if (action === 'update') {
    const value = window.prompt('New value for ' + row.key);
    if (value !== null) {
      vscode.postMessage({ action: 'set', key: row.key, value });
    }
    return;
  }
  if (action === 'copy-value') {
    vscode.postMessage({ action: 'get', key: row.key, then: 'copy' });
    return;
  }
  if (action === 'unset') {
    if (window.confirm('Unset ' + row.key + '?')) {
      vscode.postMessage({ action: 'unset', key: row.key });
    }
  }
});
window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message) return;
  if (message.action === 'revealed' && message.key && typeof message.value === 'string') {
    const row = rows.find((r) => r.rowId === message.key);
    if (row) {
      const cell = document.querySelector('[data-row-key="' + CSS.escape(message.key) + '"] .value');
      if (cell) {
        cell.textContent = message.value;
        cell.classList.remove('muted');
      }
    }
  }
});
window.dispatchEvent(new Event('env:ready'));
</script>
</body>
</html>`;
}

function renderRow(row: EnvPanelRow): string {
	return `<tr data-row-key="${escapeHtml(row.rowId)}">
  <td class="key">${escapeHtml(row.key)}${row.isSecret ? ' <span class="secret-tag">secret</span>' : ''}${row.description ? `<div class="description">${escapeHtml(row.description)}</div>` : ''}</td>
  <td class="value muted" data-value-cell>${escapeHtml(row.maskedValue)}</td>
  <td>
    <div class="row-actions">
      ${row.isSecret ? '<button type="button" class="secondary" data-action="reveal" title="Reveal">Reveal</button>' : '<button type="button" class="secondary" data-action="copy-value" title="Copy value">Copy</button>'}
      <button type="button" class="secondary" data-action="update" title="Update">Update</button>
      <button type="button" class="secondary" data-action="unset" title="Unset">Unset</button>
    </div>
  </td>
</tr>`;
}

function renderEnvContentSecurityPolicy(options: EnvPanelHtmlOptions): string {
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
