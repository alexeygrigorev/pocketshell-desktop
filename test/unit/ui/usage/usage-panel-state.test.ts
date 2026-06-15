import { describe, expect, it } from 'vitest';
import {
  aggregateWorstProviderRows,
  buildUsagePanelState,
  renderUsagePanelState,
} from '../../../../src/ui/usage';
import type { UsageSummary } from '../../../../src/integrations/usage';

const now = Date.parse('2026-06-15T10:00:00.000Z');

describe('usage panel state', () => {
  it('renders all configured hosts with ready, disconnected, stale, and error states', () => {
    const freshSummary = summary([
      provider('openai', 200, 1_000, 10, 100, 1.25, now - 1_000),
    ]);
    const staleSummary = summary([
      provider('anthropic', 900, 1_000, 90, 100, 3.5, now - 120_000),
    ]);

    const state = buildUsagePanelState({
      now,
      staleAfterMs: 60_000,
      hosts: [
        host(1, 'prod'),
        host(2, 'staging'),
        host(3, 'dev'),
        host(4, 'broken'),
      ],
      connectionStates: {
        1: 'Connected',
        2: 'Disconnected',
        3: 'Connected',
        4: 'Connected',
      },
      snapshots: {
        1: { summary: freshSummary, lastRefreshAt: now - 1_000 },
        3: { summary: staleSummary, lastRefreshAt: now - 120_000 },
        4: { errorText: 'pocketshell usage failed', lastRefreshAt: now - 500 },
      },
    });

    expect(state.rows.map((row) => [row.hostName, row.status])).toEqual([
      ['prod', 'ready'],
      ['staging', 'disconnected'],
      ['dev', 'stale'],
      ['broken', 'error'],
    ]);

    const rendered = renderUsagePanelState(state);
    expect(rendered).toContain('prod (user@prod.example.com:22) [ready]');
    expect(rendered).toContain('staging (user@staging.example.com:22) [disconnected]');
    expect(rendered).toContain('dev (user@dev.example.com:22) [stale]');
    expect(rendered).toContain('error: pocketshell usage failed');
  });

  it('aggregates provider usage using the worst host record per provider', () => {
    const state = buildUsagePanelState({
      now,
      staleAfterMs: 60_000,
      hosts: [host(1, 'low'), host(2, 'high')],
      connectionStates: { 1: 'Connected', 2: 'Connected' },
      snapshots: {
        1: { summary: summary([provider('openai', 100, 1_000, 10, 100, 0.5, now)]) },
        2: { summary: summary([provider('openai', 950, 1_000, 20, 100, 0.8, now)]) },
      },
    });

    expect(state.providerAggregates).toHaveLength(1);
    expect(state.providerAggregates[0].hostName).toBe('high');
    expect(state.providerAggregates[0].usage.tokensUsed).toBe(950);
  });

  it('keeps refreshing and disabled hosts blocked from provider aggregates', () => {
    const rows = buildUsagePanelState({
      now,
      staleAfterMs: 60_000,
      hosts: [host(1, 'refreshing'), { ...host(2, 'disabled'), enabled: false }],
      connectionStates: { 1: 'Connected', 2: 'Connected' },
      refreshingHostIds: [1],
      snapshots: {
        1: { summary: summary([provider('openai', 100, 1_000, 10, 100, 1, now)]) },
        2: { summary: summary([provider('anthropic', 100, 1_000, 10, 100, 1, now)]) },
      },
    }).rows;

    expect(rows.map((row) => row.status)).toEqual(['refreshing', 'blocked']);
    expect(aggregateWorstProviderRows(rows)).toEqual([]);
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
    totalCostUsd: providers.reduce((sum, item) => sum + (item.costUsd ?? 0), 0),
    currency: 'USD',
  };
}
