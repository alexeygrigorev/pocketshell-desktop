/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Rich WebviewPanel renderer for the Usage screen (feature parity with the
 * PocketShell Android app). Mirrors the app's per-provider card layout:
 * status pill, short/long-term windows with data-driven labels, progress
 * bars, reset countdown, and last error. Driven by `buildUsagePanelState()`.
 */

import type {
	UsagePanelState,
	UsageHostRow,
	UsageProviderAggregate,
	UsageHostRowStatus,
} from './usage-panel-state';
import type { ProviderUsage } from '../../integrations/usage';

/**
 * Status a provider card can show. Aligned with the Android app's pill set:
 * ok / limited / blocked / error / unsupported.
 */
export type UsageCardStatus = 'ok' | 'limited' | 'blocked' | 'error' | 'unsupported';

export interface UsageCardModel {
	provider: string;
	status: UsageCardStatus;
	/** Host this card reflects (worst-case per provider, per `aggregateWorstProviderRows`). */
	hostName: string;
	/** Short-term window label, e.g. "5h" or "7d". */
	shortWindowLabel: string;
	/** Long-term window label, e.g. "weekly" or "monthly". */
	longWindowLabel: string;
	/** 0..1 fraction of the short-term quota consumed. */
	shortWindowRatio: number;
	/** 0..1 fraction of the long-term quota consumed (cost-based when no token cap). */
	longWindowRatio: number;
	/** Human-readable "used / limit" for the short-term window. */
	shortWindowQuota: string;
	/** Human-readable cost for the long-term window. */
	longWindowCost: string;
	/** Reset countdown text, e.g. "resets in 3h 22m", when computable. */
	resetCountdown?: string;
	/** Last error text, when the card status is error/blocked. */
	lastError?: string;
	/** When the snapshot was last refreshed (ms epoch). */
	updatedAt?: number;
}

export interface UsagePanelHtmlModel {
	title: string;
	generatedAt: number;
	/** True when at least one host produced live data. */
	hasLiveData: boolean;
	/** True while a refresh is in flight. */
	refreshing: boolean;
	/** True when rendered from a cached snapshot before live data lands (SWR). */
	stale: boolean;
	cards: UsageCardModel[];
	/** Hosts that produced no provider data, for a compact footer list. */
	silentHosts: Array<{ hostName: string; rowStatus: UsageHostRowStatus; address: string }>;
	emptyText: string;
	/** Total cost across providers (long-term view). */
	totalCostLabel?: string;
}

const STALE_WARNING_RATIO = 0.8;
const BLOCKED_RATIO = 1.0;

/**
 * Derive a usage panel model for the webview from the canonical
 * `UsagePanelState`. Pure function — safe to unit-test without vscode.
 */
export function buildUsagePanelHtmlModel(state: UsagePanelState): UsagePanelHtmlModel {
	const now = state.generatedAt;
	const cards: UsageCardModel[] = state.providerAggregates.map((agg) => aggregateToCard(agg, now));
	const liveHosts = state.rows.filter((row) => row.status === 'ready' || row.status === 'stale');
	const silentHosts = state.rows
		.filter((row) => row.providers.length === 0 && (row.status === 'ready' || row.status === 'stale' || row.status === 'disconnected' || row.status === 'error'))
		.map((row) => ({
			hostName: row.hostName,
			rowStatus: row.status,
			address: row.address,
		}));

	const totalCost = state.providerAggregates.reduce(
		(sum, agg) => sum + (agg.usage.costUsd ?? 0),
		0,
	);

	return {
		title: 'PocketShell Usage',
		generatedAt: state.generatedAt,
		hasLiveData: cards.length > 0,
		refreshing: state.rows.some((row) => row.status === 'refreshing'),
		stale: state.rows.some((row) => row.status === 'stale'),
		cards,
		silentHosts,
		emptyText: cards.length === 0
			? 'No provider usage from compatible connected hosts yet. Connect a host and refresh.'
			: '',
		totalCostLabel: cards.length > 0 ? formatUsd(totalCost) : undefined,
	};
}

function aggregateToCard(agg: UsageProviderAggregate, now: number): UsageCardModel {
	const usage = agg.usage;
	const shortRatio = ratioOf(usage.tokensUsed, usage.tokensLimit);
	const reqRatio = ratioOf(usage.requestsUsed, usage.requestsLimit);
	// The short-term window is the most-constrained dimension.
	const shortWindowRatio = Math.max(shortRatio, reqRatio);
	const longWindowRatio = costRatio(usage);
	const status = classifyStatus(shortWindowRatio, usage);

	return {
		provider: usage.provider,
		status,
		hostName: agg.hostName,
		shortWindowLabel: shortWindowLabel(usage),
		longWindowLabel: longWindowLabel(usage),
		shortWindowRatio,
		longWindowRatio,
		shortWindowQuota: `${formatQuota(usage.tokensUsed, usage.tokensLimit)} tokens · ${formatQuota(usage.requestsUsed, usage.requestsLimit)} requests`,
		longWindowCost: usage.costUsd !== undefined ? formatUsd(usage.costUsd) : '—',
		resetCountdown: computeResetCountdown(usage, now),
		lastError: status === 'error' || status === 'blocked' ? lastErrorText(usage) : undefined,
		updatedAt: usage.updatedAt,
	};
}

/**
 * Classify a provider's status from its consumption ratio, matching the
 * app's pill set. Exported for unit testing.
 */
export function classifyUsageStatus(ratio: number): UsageCardStatus {
	if (ratio >= BLOCKED_RATIO) {
		return 'blocked';
	}
	if (ratio >= STALE_WARNING_RATIO) {
		return 'limited';
	}
	if (ratio > 0) {
		return 'ok';
	}
	// 0 ratio and no signal yet — unsupported placeholder.
	return 'unsupported';
}

function classifyStatus(ratio: number, _usage: ProviderUsage): UsageCardStatus {
	return classifyUsageStatus(ratio);
}

function ratioOf(used: number, limit: number): number {
	if (limit <= 0) {
		return 0;
	}
	return Math.min(1, used / limit);
}

function costRatio(usage: ProviderUsage): number {
	// No hard cost cap in the schema; surface cost as a soft 0..1 signal
	// using $50 as a heuristic ceiling so the long-term bar is meaningful.
	if (usage.costUsd === undefined) {
		return 0;
	}
	return Math.min(1, usage.costUsd / 50);
}

function shortWindowLabel(usage: ProviderUsage): string {
	// Data-driven labels per the parity spec: "5h" or "7d" based on period shape.
	const period = String(usage.period ?? '').toLowerCase();
	if (period.endsWith('h') || period.includes('hour') || period.includes('5h')) {
		return '5h';
	}
	if (period.endsWith('d') || period.includes('day') || period.includes('7d')) {
		return '7d';
	}
	// Default to the rolling 5h window for token/request caps.
	return '5h';
}

function longWindowLabel(usage: ProviderUsage): string {
	const period = String(usage.period ?? '').toLowerCase();
	if (period.includes('month')) {
		return 'monthly';
	}
	// Cost windows default to weekly in the app.
	if (period.includes('week') || usage.costUsd !== undefined) {
		return 'weekly';
	}
	return 'monthly';
}

function computeResetCountdown(usage: ProviderUsage, now: number): string | undefined {
	if (!usage.updatedAt || usage.tokensLimit <= 0) {
		return undefined;
	}
	// Heuristic: rolling 5h short window resets 5h after the last update.
	const windowMs = 5 * 60 * 60 * 1000;
	const resetsAt = usage.updatedAt + windowMs;
	const remaining = resetsAt - now;
	if (remaining <= 0) {
		return 'resets soon';
	}
	const hours = Math.floor(remaining / (60 * 60 * 1000));
	const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
	if (hours >= 1) {
		return `resets in ${hours}h ${minutes}m`;
	}
	return `resets in ${minutes}m`;
}

function lastErrorText(_usage: ProviderUsage): string | undefined {
	// The schema carries no per-provider error; surfaced from the host row
	// via the panel-state layer when present. Kept here for forward-compat.
	return undefined;
}

function formatQuota(used: number, limit: number): string {
	if (limit <= 0) {
		return `${formatNumber(used)} / unlimited`;
	}
	return `${formatNumber(used)} / ${formatNumber(limit)}`;
}

/** Render a provider identifier in a human-friendly form (e.g. "openai" -> "OpenAI"). */
function displayName(provider: string): string {
	const known: Record<string, string> = {
		openai: 'OpenAI',
		anthropic: 'Anthropic',
		copilot: 'Copilot',
		gemini: 'Gemini',
		codex: 'Codex',
		claude: 'Claude',
		zai: 'ZAI',
	};
	const lower = provider.toLowerCase();
	if (known[lower]) {
		return known[lower];
	}
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function formatNumber(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	return String(value);
}

function formatUsd(value: number): string {
	if (value >= 1) {
		return `$${value.toFixed(2)}`;
	}
	return `$${value.toFixed(4)}`;
}

export interface UsagePanelHtmlOptions {
	cspSource?: string;
	nonce?: string;
}

/**
 * Render the full HTML document for the Usage webview panel. Pure function.
 */
export function renderUsagePanelHtml(
	model: UsagePanelHtmlModel,
	options: UsagePanelHtmlOptions = {},
): string {
	const nonceAttribute = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
	const csp = renderUsageContentSecurityPolicy(options);
	const cspMeta = csp
		? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">\n`
		: '';
	const cardsJson = jsonForScript(model.cards);
	const generated = new Date(model.generatedAt).toLocaleString();

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
.subtitle { color: var(--vscode-descriptionForeground); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.82em; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.pill[data-tone="stale"] { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-notificationsWarningIcon-foreground); }
.pill[data-tone="refreshing"] { background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); }
.content { padding: 12px 14px; overflow: auto; }
.empty { color: var(--vscode-descriptionForeground); padding: 24px 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; background: var(--vscode-editorWidget-background); display: grid; gap: 10px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.provider { font-weight: 600; text-transform: capitalize; }
.host { color: var(--vscode-descriptionForeground); font-size: 0.86em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.78em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.status-pill[data-status="ok"] { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
.status-pill[data-status="limited"] { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-notificationsWarningIcon-foreground); }
.status-pill[data-status="blocked"] { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
.status-pill[data-status="error"] { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
.status-pill[data-status="unsupported"] { background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); }
.window { display: grid; gap: 4px; }
.window-label { display: flex; justify-content: space-between; align-items: baseline; color: var(--vscode-descriptionForeground); font-size: 0.86em; }
.window-label strong { color: var(--vscode-foreground); font-weight: 600; }
.window-value { color: var(--vscode-descriptionForeground); font-size: 0.82em; font-family: var(--vscode-editor-font-family); }
.bar { height: 6px; border-radius: 3px; background: var(--vscode-editor-background); overflow: hidden; border: 1px solid var(--vscode-panel-border); }
.bar-fill { height: 100%; border-radius: 3px; background: var(--vscode-testing-iconPassed); }
.bar-fill[data-tone="limited"] { background: var(--vscode-notificationsWarningIcon-foreground); }
.bar-fill[data-tone="blocked"] { background: var(--vscode-errorForeground); }
.card-footer { display: flex; justify-content: space-between; gap: 8px; font-size: 0.8em; color: var(--vscode-descriptionForeground); flex-wrap: wrap; }
.error-text { color: var(--vscode-errorForeground); font-size: 0.86em; }
.silent-hosts { margin-top: 18px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border); }
.silent-hosts h3 { font-size: 0.9em; margin: 0 0 6px 0; color: var(--vscode-descriptionForeground); font-weight: 600; }
.silent-host { font-size: 0.84em; color: var(--vscode-descriptionForeground); padding: 2px 0; }
button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 5px 9px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
@media (max-width: 620px) {
  .cards { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<section class="panel" aria-label="PocketShell usage">
  <header class="header">
    <div class="title">Usage</div>
    <div class="subtitle">${escapeHtml(model.title)}</div>
    <div class="toolbar">
      ${model.refreshing ? '<span class="pill" data-tone="refreshing">refreshing…</span>' : ''}
      ${model.stale ? '<span class="pill" data-tone="stale">cached</span>' : ''}
      <button type="button" data-action="refresh">Refresh</button>
    </div>
  </header>
  <main class="content">
    ${model.cards.length === 0
      ? `<div class="empty">${escapeHtml(model.emptyText)}</div>`
      : `<div class="cards">${model.cards.map(renderCard).join('')}</div>`}
    ${model.silentHosts.length > 0
      ? `<div class="silent-hosts"><h3>Other hosts</h3>${model.silentHosts.map((host) => `<div class="silent-host">${escapeHtml(host.hostName)} (${escapeHtml(host.address)}) — ${escapeHtml(host.rowStatus)}</div>`).join('')}</div>`
      : ''}
    <div class="card-footer" style="margin-top:14px;">
      <span>Generated ${escapeHtml(generated)}</span>
      ${model.totalCostLabel ? `<span>Total (long-term): <strong>${escapeHtml(model.totalCostLabel)}</strong></span>` : ''}
    </div>
  </main>
</section>
<script${nonceAttribute}>
const vscode = acquireVsCodeApi();
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  if (button.dataset.action === 'refresh') {
    vscode.postMessage({ action: 'refresh' });
  }
});
const cards = ${cardsJson};
window.dispatchEvent(new Event('usage:ready'));
</script>
</body>
</html>`;
}

function renderCard(card: UsageCardModel): string {
	const shortTone = barTone(card.shortWindowRatio);
	const longTone = barTone(card.longWindowRatio);
	return `<article class="card" data-provider="${escapeHtml(card.provider.toLowerCase())}">
  <div class="card-head">
    <div>
      <div class="provider">${escapeHtml(displayName(card.provider))}</div>
      <div class="host">${escapeHtml(card.hostName)}</div>
    </div>
    <span class="status-pill" data-status="${escapeHtml(card.status)}">${escapeHtml(card.status)}</span>
  </div>
  <div class="window">
    <div class="window-label"><span><strong>${escapeHtml(card.shortWindowLabel)}</strong> short-term</span><span class="window-value">${escapeHtml(card.shortWindowQuota)}</span></div>
    <div class="bar"><div class="bar-fill" data-tone="${shortTone}" style="width: ${Math.round(card.shortWindowRatio * 100)}%"></div></div>
  </div>
  <div class="window">
    <div class="window-label"><span><strong>${escapeHtml(card.longWindowLabel)}</strong> long-term</span><span class="window-value">${escapeHtml(card.longWindowCost)}</span></div>
    <div class="bar"><div class="bar-fill" data-tone="${longTone}" style="width: ${Math.round(card.longWindowRatio * 100)}%"></div></div>
  </div>
  <div class="card-footer">
    ${card.resetCountdown ? `<span>${escapeHtml(card.resetCountdown)}</span>` : '<span></span>'}
    ${card.updatedAt ? `<span>updated ${escapeHtml(new Date(card.updatedAt).toLocaleTimeString())}</span>` : ''}
  </div>
  ${card.lastError ? `<div class="error-text">${escapeHtml(card.lastError)}</div>` : ''}
</article>`;
}

function barTone(ratio: number): 'ok' | 'limited' | 'blocked' {
	if (ratio >= BLOCKED_RATIO) {
		return 'blocked';
	}
	if (ratio >= STALE_WARNING_RATIO) {
		return 'limited';
	}
	return 'ok';
}

function renderUsageContentSecurityPolicy(options: UsagePanelHtmlOptions): string {
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
