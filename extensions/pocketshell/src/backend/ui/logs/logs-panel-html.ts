/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Rich WebviewPanel HTML renderer for the Logs screen. A bounded streaming
 * tail of the remote `pocketshell logs` trace stream: the most recent
 * `lines` are rendered as a monospace list that auto-scrolls to the bottom
 * on new data, with an explicit Clear action. Matches the `tail`/`show`/
 * `clear` semantics of the legacy OutputChannel commands.
 *
 * Pure function — safe to unit-test without vscode.
 */

import type { LogsPanelModel, LogsPanelLine } from './logs-panel-state';

export interface LogsPanelHtmlOptions {
	cspSource?: string;
	nonce?: string;
}

/**
 * Render the full HTML document for the Logs webview panel. Pure function.
 * Relies on `acquireVsCodeApi()` for actions: refresh, clear, tail-toggle.
 */
export function renderLogsPanelHtml(
	model: LogsPanelModel,
	options: LogsPanelHtmlOptions = {},
): string {
	const nonceAttribute = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
	const csp = renderLogsContentSecurityPolicy(options);
	const cspMeta = csp
		? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">\n`
		: '';
	const linesJson = jsonForScript(model.lines);

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
.pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.78em; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.pill[data-tone="tailing"] { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
.pill[data-tone="disconnected"] { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
.status { margin: 0 14px; padding: 7px 9px; border-left: 3px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
.status[data-tone="success"] { border-left-color: var(--vscode-testing-iconPassed); }
.status[data-tone="error"] { border-left-color: var(--vscode-errorForeground); }
.status[data-tone="warning"] { border-left-color: var(--vscode-notificationsWarningIcon-foreground); }
.status[data-tone="info"] { border-left-color: var(--vscode-textLink-foreground); }
.content { overflow: auto; padding: 8px 14px 24px; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px 0; }
.log-list { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre-wrap; overflow-wrap: anywhere; }
.log-line { display: grid; grid-template-columns: auto auto auto 1fr; gap: 8px; padding: 1px 0; }
.log-time { color: var(--vscode-descriptionForeground); white-space: nowrap; }
.log-level { font-weight: 600; text-transform: uppercase; font-size: 0.84em; min-width: 3.5em; }
.log-level[data-tone="debug"] { color: var(--vscode-descriptionForeground); }
.log-level[data-tone="info"] { color: var(--vscode-textLink-foreground); }
.log-level[data-tone="warn"] { color: var(--vscode-notificationsWarningIcon-foreground); }
.log-level[data-tone="error"] { color: var(--vscode-errorForeground); }
.log-source { color: var(--vscode-descriptionForeground); white-space: nowrap; }
.log-source::before { content: '['; }
.log-source::after { content: ']'; }
.log-source:empty { display: none; }
.log-message { min-width: 0; }
.footer { padding: 6px 14px; border-top: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-size: 0.82em; display: flex; gap: 14px; flex-wrap: wrap; }
button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 5px 9px; border-radius: 4px; cursor: pointer; white-space: nowrap; font: inherit; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
<section class="panel" aria-label="PocketShell logs">
  <header class="header">
    <div class="title">Logs</div>
    <div class="subtitle">${escapeHtml(model.hostName)}</div>
    <div class="toolbar">
      ${model.tailing ? '<span class="pill" data-tone="tailing">tailing</span>' : ''}
      ${model.connected ? '' : '<span class="pill" data-tone="disconnected">disconnected</span>'}
      <button type="button" data-action="refresh">Refresh</button>
      <button type="button" class="secondary" data-action="tail">${model.tailing ? 'Stop tail' : 'Tail'}</button>
      <button type="button" class="secondary" data-action="clear">Clear</button>
    </div>
  </header>
  ${model.status ? `<div class="status" role="status" data-tone="${escapeHtml(model.status.tone)}">${escapeHtml(model.status.message)}</div>` : ''}
  <main class="content" id="log-content">
    ${model.lines.length === 0
      ? `<div class="empty">${escapeHtml(model.emptyText)}</div>`
      : `<div class="log-list" id="log-list">${model.lines.map(renderLine).join('')}</div>`}
  </main>
  <footer class="footer">
    <span>${escapeHtml(String(model.totalSeen))} total</span>
    ${model.dropped > 0 ? `<span>${escapeHtml(String(model.dropped))} dropped (head bound)</span>` : ''}
    <span>${escapeHtml(String(model.lines.length))} shown</span>
  </footer>
</section>
<script${nonceAttribute}>
const vscode = acquireVsCodeApi();
const lines = ${linesJson};
const content = document.getElementById('log-content');
function scrollToBottom() {
  if (content) { content.scrollTop = content.scrollHeight; }
}
// Auto-scroll to the latest entry on (re)render — matches streaming-tail UX.
scrollToBottom();
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'refresh' || action === 'tail' || action === 'clear') {
    vscode.postMessage({ action });
  }
});
window.dispatchEvent(new Event('logs:ready'));
</script>
</body>
</html>`;
}

function renderLine(line: LogsPanelLine): string {
	const time = formatTime(line.timestamp);
	return `<div class="log-line" id="log-line-${escapeHtml(String(line.seq))}">
  <span class="log-time">${escapeHtml(time)}</span>
  <span class="log-level" data-tone="${escapeHtml(line.tone)}">${escapeHtml(line.level)}</span>
  <span class="log-source">${escapeHtml(line.source ?? '')}</span>
  <span class="log-message">${escapeHtml(line.message)}</span>
</div>`;
}

function formatTime(ms: number): string {
	if (!ms || ms <= 0 || Number.isNaN(ms)) {
		return '—';
	}
	try {
		return new Date(ms).toISOString();
	} catch {
		return '—';
	}
}

function renderLogsContentSecurityPolicy(options: LogsPanelHtmlOptions): string {
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
