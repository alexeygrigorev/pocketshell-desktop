/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Rich WebviewPanel HTML renderer for the Jobs screen (feature parity with
 * the PocketShell Android RecurringJobs screen). Mirrors the app's per-job
 * row: status pill, schedule line, and a per-row cancel action. Driven by
 * `buildJobsPanelModel()`.
 *
 * Pure function — safe to unit-test without vscode.
 */

import type { JobsPanelModel, JobsPanelRow } from './jobs-panel-state';

export interface JobsPanelHtmlOptions {
	cspSource?: string;
	nonce?: string;
}

/**
 * Render the full HTML document for the Jobs webview panel. Pure function.
 * Relies on `acquireVsCodeApi()` for actions: refresh, cancel.
 */
export function renderJobsPanelHtml(
	model: JobsPanelModel,
	options: JobsPanelHtmlOptions = {},
): string {
	const nonceAttribute = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
	const csp = renderJobsContentSecurityPolicy(options);
	const cspMeta = csp
		? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">\n`
		: '';
	const rowsJson = jsonForScript(model.rows);

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta}<meta name="viewport" content="width=device-width, initial-scale=1">
<style${nonceAttribute}>
:root { color-scheme: light dark; }
body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.panel { box-sizing: border-box; min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
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
.rows { display: grid; gap: 8px; }
.row { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; background: var(--vscode-editorWidget-background); display: grid; grid-template-columns: 1fr auto; gap: 8px 10px; align-items: center; }
.row-head { min-width: 0; }
.row-title { font-weight: 600; overflow-wrap: anywhere; }
.row-title .fallback { color: var(--vscode-descriptionForeground); }
.schedule { color: var(--vscode-descriptionForeground); font-size: 0.86em; font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
.row-meta { color: var(--vscode-descriptionForeground); font-size: 0.82em; font-family: var(--vscode-editor-font-family); }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; background: var(--vscode-descriptionForeground); }
.dot[data-tone="active"] { background: var(--vscode-testing-iconPassed); }
.dot[data-tone="error"] { background: var(--vscode-errorForeground); }
.dot[data-tone="idle"] { background: var(--vscode-descriptionForeground); }
.pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.78em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.pill[data-tone="active"] { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
.pill[data-tone="error"] { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
.pill[data-tone="idle"] { background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); }
.row-actions { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 5px 9px; border-radius: 4px; cursor: pointer; white-space: nowrap; font: inherit; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.55; cursor: default; }
.disconnected { color: var(--vscode-errorForeground); font-size: 0.86em; }
@media (max-width: 620px) {
  .row { grid-template-columns: 1fr; }
  .row-actions { justify-content: flex-start; }
}
</style>
</head>
<body>
<section class="panel" aria-label="PocketShell jobs">
  <header class="header">
    <div class="title">Jobs</div>
    <div class="subtitle">${escapeHtml(model.hostName)}</div>
    <div class="toolbar">
      ${model.connected ? '' : '<span class="disconnected">disconnected</span>'}
      <button type="button" data-action="refresh">Refresh</button>
    </div>
  </header>
  <main class="content">
    ${model.status ? `<div class="status" role="status" data-tone="${escapeHtml(model.status.tone)}">${escapeHtml(model.status.message)}</div>` : ''}
    ${model.rows.length === 0
      ? `<div class="empty">${escapeHtml(model.emptyText)}</div>`
      : `<div class="rows">${model.rows.map(renderRow).join('')}</div>`}
  </main>
</section>
<script${nonceAttribute}>
const vscode = acquireVsCodeApi();
const rows = ${rowsJson};
function findRow(button) {
  const id = button.closest('[data-row-id]')?.dataset.rowId;
  return rows.find((row) => row.rowId === id);
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'refresh') {
    vscode.postMessage({ action: 'refresh' });
    return;
  }
  const row = findRow(button);
  if (!row) return;
  if (action === 'cancel') {
    if (window.confirm('Cancel job ' + row.id + '?')) {
      vscode.postMessage({ action: 'cancel', jobId: row.id });
    }
  }
  if (action === 'logs') {
    vscode.postMessage({ action: 'logs', jobId: row.id });
  }
});
window.dispatchEvent(new Event('jobs:ready'));
</script>
</body>
</html>`;
}

function renderRow(row: JobsPanelRow): string {
	const canCancel = row.status === 'running' || row.status === 'queued';
	return `<article class="row" data-row-id="${escapeHtml(row.rowId)}">
  <div class="row-head">
    <div class="row-title"><span class="dot" data-tone="${escapeHtml(row.cardStatus)}"></span>${escapeHtml(row.command) || `<span class="fallback">Job ${escapeHtml(row.id)}</span>`}</div>
    <div class="schedule">${escapeHtml(row.sessionId || 'no session')} | <span class="row-meta">${escapeHtml(row.status)}</span> | <span class="row-meta">${escapeHtml(formatStarted(row.startedAt))}</span></div>
    ${row.cwd ? `<div class="row-meta">${escapeHtml(row.cwd)}</div>` : ''}
    ${row.completedAt !== undefined || row.exitCode !== undefined ? `<div class="row-meta">${row.completedAt !== undefined ? `completed ${escapeHtml(formatStarted(row.completedAt))}` : ''}${row.exitCode !== undefined ? ` · exit ${escapeHtml(String(row.exitCode))}` : ''}</div>` : ''}
  </div>
  <div class="row-actions">
    <span class="pill" data-tone="${escapeHtml(row.cardStatus)}">${escapeHtml(row.status)}</span>
    <button type="button" class="secondary" data-action="logs" title="Job logs">Logs</button>
    <button type="button" class="secondary" data-action="cancel" title="Cancel job" ${canCancel ? '' : 'disabled'}>Cancel</button>
  </div>
</article>`;
}

function formatStarted(ms: number): string {
	if (!ms || ms <= 0) {
		return '—';
	}
	try {
		return new Date(ms).toLocaleString();
	} catch {
		return '—';
	}
}

function renderJobsContentSecurityPolicy(options: JobsPanelHtmlOptions): string {
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
