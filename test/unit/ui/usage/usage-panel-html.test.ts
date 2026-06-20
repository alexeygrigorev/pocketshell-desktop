import { describe, expect, it } from 'vitest';
import {
  buildUsagePanelHtmlModel,
  classifyUsageStatus,
  renderUsagePanelHtml,
} from '../../../../src/ui/usage';
import { buildUsagePanelState } from '../../../../src/ui/usage';
import type { UsageSummary } from '../../../../src/integrations/usage';

const now = Date.parse('2026-06-15T10:00:00.000Z');

describe('classifyUsageStatus', () => {
  it('maps ratio buckets to the app pill set', () => {
    expect(classifyUsageStatus(0)).toBe('unsupported');
    expect(classifyUsageStatus(0.1)).toBe('ok');
    expect(classifyUsageStatus(0.79)).toBe('ok');
    expect(classifyUsageStatus(0.8)).toBe('limited');
    expect(classifyUsageStatus(0.95)).toBe('limited');
    expect(classifyUsageStatus(1.0)).toBe('blocked');
    expect(classifyUsageStatus(1.5)).toBe('blocked');
  });
});

describe('buildUsagePanelHtmlModel', () => {
  it('builds per-provider cards from the panel state with status, windows, and reset countdown', () => {
    const freshSummary = summary([
      provider('openai', 850, 1_000, 10, 100, 1.25, now - 1_000), // 85% tokens -> limited
      provider('anthropic', 100, 1_000, 5, 100, 0.5, now - 1_000), // 10% -> ok
    ]);

    const state = buildUsagePanelState({
      now,
      staleAfterMs: 60_000,
      hosts: [host(1, 'prod')],
      connectionStates: { 1: 'Connected' },
      snapshots: { 1: { summary: freshSummary, lastRefreshAt: now - 1_000 } },
    });

    const model = buildUsagePanelHtmlModel(state);

    expect(model.hasLiveData).toBe(true);
    expect(model.cards).toHaveLength(2);
    const openai = model.cards.find((c) => c.provider === 'openai');
    expect(openai).toBeDefined();
    expect(openai!.status).toBe('limited');
    expect(openai!.shortWindowRatio).toBeCloseTo(0.85, 5);
    expect(['5h', '7d']).toContain(openai!.shortWindowLabel);
    expect(['weekly', 'monthly']).toContain(openai!.longWindowLabel);
    expect(openai!.resetCountdown).toMatch(/resets in/);
    expect(openai!.shortWindowQuota).toContain('tokens');

    const anthropic = model.cards.find((c) => c.provider === 'anthropic');
    expect(anthropic!.status).toBe('ok');
    expect(anthropic!.longWindowCost).toBe('$0.5000');
  });

  it('reports refreshing + stale flags from the panel state', () => {
    const state = buildUsagePanelState({
      now,
      staleAfterMs: 60_000,
      hosts: [host(1, 'prod'), host(2, 'stale')],
      connectionStates: { 1: 'Connected', 2: 'Connected' },
      refreshingHostIds: new Set([1]),
      snapshots: { 2: { summary: summary([provider('openai', 1, 1_000, 1, 100, 0, now - 120_000)]), lastRefreshAt: now - 120_000 } },
    });
    const model = buildUsagePanelHtmlModel(state);
    expect(model.refreshing).toBe(true);
    expect(model.stale).toBe(true);
  });

  it('lists silent hosts (no providers) in the footer', () => {
    const state = buildUsagePanelState({
      now,
      staleAfterMs: 60_000,
      hosts: [host(1, 'prod'), host(2, 'idle')],
      connectionStates: { 1: 'Connected', 2: 'Connected' },
      snapshots: {
        1: { summary: summary([provider('openai', 1, 1_000, 1, 100, 0, now)]), lastRefreshAt: now },
        2: { summary: summary([]), lastRefreshAt: now },
      },
    });
    const model = buildUsagePanelHtmlModel(state);
    expect(model.cards).toHaveLength(1);
    expect(model.silentHosts.map((h) => h.hostName)).toEqual(['idle']);
  });
});

describe('renderUsagePanelHtml', () => {
  it('renders a card per provider with status pill, progress bars, and CSP/nonce', () => {
    const state = buildUsagePanelState({
      now,
      staleAfterMs: 60_000,
      hosts: [host(1, 'prod')],
      connectionStates: { 1: 'Connected' },
      snapshots: {
        1: {
          summary: summary([provider('openai', 950, 1_000, 10, 100, 5.0, now - 1_000)]),
          lastRefreshAt: now - 1_000,
        },
      },
    });
    const model = buildUsagePanelHtmlModel(state);
    const html = renderUsagePanelHtml(model, {
      cspSource: 'https://test.vscode',
      nonce: 'abc123',
    });

    expect(html).toContain('data-status="blocked"');
    expect(html).toContain('OpenAI');
    expect(html).toContain('resets in');
    expect(html).toContain('nonce="abc123"');
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain('nonce-abc123');
    // The blocked short-term bar should be at 95%.
    expect(html).toContain('width: 95%');
  });

  it('renders the empty state when no provider data is available', () => {
    const state = buildUsagePanelState({
      now,
      staleAfterMs: 60_000,
      hosts: [],
      connectionStates: {},
    });
    const model = buildUsagePanelHtmlModel(state);
    const html = renderUsagePanelHtml(model, {});
    expect(model.cards).toHaveLength(0);
    expect(html).toContain('No provider usage');
    expect(html).not.toContain('data-provider=');
  });

  it('escapes provider and host names to prevent HTML injection', () => {
    const state = buildUsagePanelState({
      now,
      staleAfterMs: 60_000,
      hosts: [{ id: 1, name: '<script>', hostname: 'h.example', username: 'u', port: 22 }],
      connectionStates: { 1: 'Connected' },
      snapshots: {
        1: {
          summary: summary([provider('openai<>', 1, 1_000, 1, 100, 0, now)]),
          lastRefreshAt: now,
        },
      },
    });
    const model = buildUsagePanelHtmlModel(state);
    const html = renderUsagePanelHtml(model, {});
    // The host name value must be HTML-escaped (not rendered as a live tag).
    expect(html).toContain('&lt;script&gt;');
    // And the raw value must never appear as an unescaped element/attribute.
    expect(html).not.toMatch(/class="host"><script>/);
    expect(html).not.toMatch(/data-provider="openai<>"/);
  });
});

function host(id: number, name: string) {
  return {
    id,
    name,
    hostname: `${name}.example.com`,
    username: 'user',
    port: 22,
  };
}

function provider(
  name: string,
  tokensUsed: number,
  tokensLimit: number,
  requestsUsed: number,
  requestsLimit: number,
  costUsd: number,
  updatedAt: number,
) {
  return {
    provider: name,
    tokensUsed,
    tokensLimit,
    requestsUsed,
    requestsLimit,
    costUsd,
    period: '2026-06',
    updatedAt,
  };
}

function summary(providers: ReturnType<typeof provider>[]): UsageSummary {
  return {
    providers,
    totalCostUsd: providers.reduce((sum, p) => sum + p.costUsd, 0),
    currency: 'USD',
  };
}
