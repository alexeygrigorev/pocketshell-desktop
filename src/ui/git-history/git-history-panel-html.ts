/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * HTML renderer for the Git History webview panel. Pure function.
 *
 * Relies on `acquireVsCodeApi()` for actions: switchTab, refresh, openGitHub,
 * openIssue. The Issues tab is shown only for GitHub origins (when
 * `model.issuesGate !== 'hidden'`).
 */

import type { GitHistoryPanelModel, GitHistoryPanelHtmlOptions } from './git-history-panel-state';

/**
 * Render the full HTML document for the Git History webview panel. Pure function.
 */
export function renderGitHistoryPanelHtml(
  model: GitHistoryPanelModel,
  options: GitHistoryPanelHtmlOptions = {},
): string {
  const nonceAttribute = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
  const csp = renderGitHistoryContentSecurityPolicy(options);
  const cspMeta = csp
    ? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">\n`
    : '';

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
.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--vscode-panel-border); padding: 0 14px; }
.tab { background: transparent; color: var(--vscode-descriptionForeground); border: 0; border-bottom: 2px solid transparent; padding: 8px 12px; cursor: pointer; font: inherit; border-radius: 0; }
.tab:hover { color: var(--vscode-foreground); }
.tab[data-active="true"] { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
.content { padding: 12px 14px; overflow: auto; }
.status { margin-bottom: 10px; padding: 7px 9px; border-left: 3px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
.status[data-tone="success"] { border-left-color: var(--vscode-testing-iconPassed); }
.status[data-tone="error"] { border-left-color: var(--vscode-errorForeground); }
.status[data-tone="warning"] { border-left-color: var(--vscode-notificationsWarningIcon-foreground); }
.status[data-tone="info"] { border-left-color: var(--vscode-textLink-foreground); }
.empty { color: var(--vscode-descriptionForeground); padding: 16px 0; }
.section { margin-bottom: 16px; }
.section h2 { margin: 0 0 8px 0; font-size: 1em; font-weight: 600; color: var(--vscode-foreground); }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-family: var(--vscode-editor-font-family); }
.kv dt { color: var(--vscode-descriptionForeground); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.pill { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 0.78em; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.pill.ok { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
.pill.warn { background: var(--vscode-notificationsWarningIcon-foreground); color: var(--vscode-editor-background); }
.list { display: grid; gap: 4px; }
.row-item { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 10px; background: var(--vscode-editorWidget-background); display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: baseline; font-family: var(--vscode-editor-font-family); }
.row-item .name { overflow-wrap: anywhere; }
.row-item .meta { color: var(--vscode-descriptionForeground); font-size: 0.86em; }
.commit .hash { font-weight: 600; color: var(--vscode-textLink-foreground); }
.commit .author { color: var(--vscode-descriptionForeground); }
.commit .date { color: var(--vscode-descriptionForeground); font-size: 0.86em; }
.commit .subject { overflow-wrap: anywhere; }
.issue .num { font-weight: 600; color: var(--vscode-textLink-foreground); }
.issue .state { font-size: 0.78em; font-weight: 600; }
.issue .state.open { color: var(--vscode-testing-iconPassed); }
.issue .state.closed { color: var(--vscode-descriptionForeground); }
.issue .subject { overflow-wrap: anywhere; }
.issue .labels { display: flex; flex-wrap: wrap; gap: 4px; }
.issue .label { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 0.76em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.hint-card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; background: var(--vscode-editorWidget-background); }
.hint-card .hint-title { font-weight: 600; margin-bottom: 4px; }
.hint-card .hint-body { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 0.9em; overflow-wrap: anywhere; }
.row-button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 3px 7px; border-radius: 4px; cursor: pointer; white-space: nowrap; font: inherit; font-size: 0.9em; }
.row-button:hover { background: var(--vscode-button-hoverBackground); }
button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 5px 9px; border-radius: 4px; cursor: pointer; white-space: nowrap; font: inherit; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.55; cursor: default; }
</style>
</head>
<body>
<section class="panel" aria-label="PocketShell git history">
  <header class="header">
    <div class="title">Git History</div>
    <div class="subtitle">${escapeHtml(model.repoPath)}</div>
    <div class="toolbar">
      ${model.github ? `<button type="button" data-action="openGitHub" data-url="${escapeHtml(model.github.url)}">Open on GitHub</button>` : ''}
      <button type="button" data-action="refresh">Refresh</button>
    </div>
  </header>
  <nav class="tabs" role="tablist">
    <button type="button" class="tab" role="tab" data-tab="overview" data-active="${String(model.tab === 'overview')}">Overview</button>
    <button type="button" class="tab" role="tab" data-tab="commits" data-active="${String(model.tab === 'commits')}">Commits</button>
    ${model.issuesGate.kind !== 'hidden' ? `<button type="button" class="tab" role="tab" data-tab="issues" data-active="${String(model.tab === 'issues')}">Issues</button>` : ''}
  </nav>
  <main class="content">
    ${model.statusBanner ? `<div class="status" role="status" data-tone="${escapeHtml(model.statusBanner.tone)}">${escapeHtml(model.statusBanner.message)}</div>` : ''}
    ${renderActiveTab(model)}
  </main>
</section>
<script${nonceAttribute}>
const vscode = acquireVsCodeApi();
let activeTab = ${jsonForScript(model.tab)};
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
  if (action === 'openGitHub') {
    const url = button.dataset.url;
    if (url) {
      vscode.postMessage({ action: 'openGitHub', url });
    }
    return;
  }
  if (action === 'openIssue') {
    const url = button.dataset.url;
    if (url) {
      vscode.postMessage({ action: 'openIssue', url });
    }
    return;
  }
});
window.dispatchEvent(new Event('git-history:ready'));
</script>
</body>
</html>`;
}

function renderActiveTab(model: GitHistoryPanelModel): string {
  if (model.tab === 'commits') {
    return renderCommitsTab(model);
  }
  if (model.tab === 'issues') {
    return renderIssuesTab(model);
  }
  return renderOverviewTab(model);
}

function renderOverviewTab(model: GitHistoryPanelModel): string {
  if (model.missing) {
    return `<div class="empty">${escapeHtml(model.emptyText)}</div>`;
  }
  if (!model.status) {
    return `<div class="empty">No repository status available.</div>`;
  }
  const s = model.status;
  const dirtyPill = s.isClean
    ? `<span class="pill ok">clean</span>`
    : `<span class="pill warn">${escapeHtml(String(s.changedFiles))} changed</span>`;
  const abText = (s.ahead > 0 || s.behind > 0)
    ? `ahead ${s.ahead}, behind ${s.behind}`
    : 'up to date';

  const parts: string[] = [];
  parts.push(`<section class="section"><h2>Repository status</h2><dl class="kv">`);
  parts.push(`<dt>Branch</dt><dd>${escapeHtml(s.branch || '(detached)')} ${dirtyPill}</dd>`);
  if (s.upstream) {
    parts.push(`<dt>Upstream</dt><dd>${escapeHtml(s.upstream)}</dd>`);
  }
  parts.push(`<dt>Sync</dt><dd>${escapeHtml(abText)}</dd>`);
  if (s.lastCommit) {
    parts.push(`<dt>Last commit</dt><dd>${escapeHtml(s.lastCommit.shortHash)} ${escapeHtml(s.lastCommit.subject)} <span class="date">— ${escapeHtml(s.lastCommit.author)} · ${escapeHtml(formatDate(s.lastCommit.date))}</span></dd>`);
  }
  parts.push(`</dl></section>`);

  if (model.branches.length > 0) {
    parts.push(`<section class="section"><h2>Branches (${escapeHtml(String(model.branches.length))})</h2><div class="list">`);
    for (const b of model.branches) {
      const cur = b.isCurrent ? '<span class="pill">current</span> ' : '';
      const remote = b.isRemote ? ' <span class="pill">remote</span>' : '';
      const tracking = b.tracking ? ` <span class="meta">tracks ${escapeHtml(b.tracking)}</span>` : '';
      parts.push(`<div class="row-item"><span class="name">${cur}${escapeHtml(b.name)}${remote}</span><span class="meta">${tracking.trim()}</span></div>`);
    }
    parts.push(`</div></section>`);
  }

  if (model.worktrees.length > 0) {
    parts.push(`<section class="section"><h2>Worktrees (${escapeHtml(String(model.worktrees.length))})</h2><div class="list">`);
    for (const w of model.worktrees) {
      const mainTag = w.isMain ? '<span class="pill">main</span> ' : '';
      const flags = [
        w.isBare ? 'bare' : '',
        w.isLocked ? 'locked' : '',
        w.isPrunable ? 'prunable' : '',
      ].filter(Boolean).map((f) => `<span class="pill warn">${escapeHtml(f)}</span>`).join(' ');
      const head = w.headShort ? ` <span class="meta">${escapeHtml(w.headShort)}</span>` : '';
      parts.push(`<div class="row-item"><span class="name">${mainTag}${escapeHtml(w.label)} <span class="meta">${escapeHtml(w.path)}</span>${head}</span><span>${flags}</span></div>`);
    }
    parts.push(`</div></section>`);
  }

  return parts.join('');
}

function renderCommitsTab(model: GitHistoryPanelModel): string {
  if (model.commits.length === 0) {
    return `<div class="empty">${escapeHtml(model.emptyText)}</div>`;
  }
  const rows = model.commits.map((c) => `<div class="row-item commit">
  <span class="subject"><span class="hash">${escapeHtml(c.shortHash)}</span> ${escapeHtml(c.subject)}</span>
  <span class="date">${escapeHtml(formatDate(c.date))}</span>
  <span class="author">${escapeHtml(c.author)}</span>
  <span class="date">${escapeHtml(String(c.fileCount))} file(s)</span>
</div>`);
  return `<section class="section"><h2>Recent commits (${escapeHtml(String(model.commits.length))})</h2><div class="list">${rows.join('')}</div></section>`;
}

/**
 * Issues tab (app §6 / #649). Mirrors the app's `IssuesPanel` states:
 *  - `hint`        → a "Configure gh to see issues" card with the hint body.
 *  - `unavailable` → a neutral "Issues unavailable" message.
 *  - `ready`       → the issue list (or an empty-state when zero rows).
 *  - `hidden`      → not reached (the tab is omitted from the nav for non-GitHub
 *                    origins; a stray request renders nothing).
 */
function renderIssuesTab(model: GitHistoryPanelModel): string {
  const gate = model.issuesGate;
  if (gate.kind === 'hint') {
    return `<section class="section"><h2>GitHub issues</h2>
<div class="hint-card">
  <div class="hint-title">Configure gh to see issues</div>
  <div class="hint-body">${escapeHtml(gate.hint)}</div>
</div></section>`;
  }
  if (gate.kind === 'unavailable') {
    return `<section class="section"><h2>GitHub issues</h2>
<div class="hint-card">
  <div class="hint-title">Issues unavailable</div>
  <div class="hint-body">Couldn't list GitHub issues for this repository.</div>
</div></section>`;
  }
  if (gate.kind !== 'ready') {
    // `hidden` — the tab shouldn't be reachable, but degrade gracefully.
    return `<div class="empty">Issues tab is not available for this repository.</div>`;
  }
  const issues = model.issues ?? [];
  if (issues.length === 0) {
    return `<section class="section"><h2>GitHub issues</h2>
<div class="empty">${escapeHtml(model.emptyText || 'This repository has no GitHub issues.')}</div></section>`;
  }
  const rows = issues.map((issue) => {
    const labels = issue.labels.length > 0
      ? `<span class="labels">${issue.labels.map((l) => `<span class="label">${escapeHtml(l)}</span>`).join('')}</span>`
      : '';
    const updated = issue.updatedAt ? `<span class="date">updated ${escapeHtml(formatDate(issue.updatedAt))}</span>` : '';
    const openBtn = issue.url
      ? `<button type="button" class="row-button" data-action="openIssue" data-url="${escapeHtml(issue.url)}">Open</button>`
      : '';
    const stateBadge = issue.state === 'open'
      ? `<span class="state open">● open</span>`
      : issue.state === 'closed'
        ? `<span class="state closed">● closed</span>`
        : '';
    return `<div class="row-item issue">
  <span class="subject"><span class="num">#${escapeHtml(String(issue.number))}</span> ${escapeHtml(issue.title || '(no title)')}</span>
  <span class="meta">${stateBadge}</span>
  <span class="meta"><span class="num">#${escapeHtml(String(issue.number))}</span>${issue.labels.length > 0 ? ` · ${escapeHtml(issue.labels.join(', '))}` : ''}</span>
  ${updated}
  ${labels}
  ${openBtn}
</div>`;
  });
  return `<section class="section"><h2>GitHub issues (${escapeHtml(String(issues.length))})</h2><div class="list">${rows.join('')}</div></section>`;
}

function formatDate(iso: string): string {
  if (!iso) {
    return '';
  }
  // Render only the date portion (YYYY-MM-DD) for compactness.
  return iso.slice(0, 10);
}

function renderGitHistoryContentSecurityPolicy(options: GitHistoryPanelHtmlOptions): string {
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
