import type { ProviderUsage, UsageSummary } from '../../integrations/usage';
import type { AiCostRecord, AiCostSummary } from './ai-costs';
import { summarizeAiCosts } from './ai-costs';

export type UsageHostConnectionState =
  | 'Idle'
  | 'Connecting'
  | 'Connected'
  | 'Disconnecting'
  | 'Disconnected'
  | 'Error'
  | string;

export type UsageHostRowStatus =
  | 'disconnected'
  | 'blocked'
  | 'refreshing'
  | 'ready'
  | 'error'
  | 'stale';

export interface UsagePanelHost {
  id: number;
  name: string;
  hostname: string;
  username?: string;
  port?: number;
  enabled?: boolean;
}

export interface UsageHostSnapshot {
  summary?: UsageSummary;
  lastRefreshAt?: number;
  errorText?: string;
  blockedReason?: string;
}

export interface UsagePanelStateInput {
  hosts: readonly UsagePanelHost[];
  connectionStates: ReadonlyMap<number, UsageHostConnectionState> | Record<number, UsageHostConnectionState>;
  snapshots?: ReadonlyMap<number, UsageHostSnapshot> | Record<number, UsageHostSnapshot>;
  refreshingHostIds?: ReadonlySet<number> | readonly number[];
  now: number;
  staleAfterMs: number;
  usageEnabled?: boolean;
  localCostRecords?: readonly AiCostRecord[];
}

export interface UsageHostRow {
  hostId: number;
  hostName: string;
  address: string;
  connectionState: UsageHostConnectionState;
  status: UsageHostRowStatus;
  providers: ProviderUsage[];
  totalCostUsd: number;
  currency: string;
  lastRefreshAt?: number;
  stale: boolean;
  errorText?: string;
  blockedReason?: string;
}

export interface UsageProviderAggregate {
  provider: string;
  hostId: number;
  hostName: string;
  usage: ProviderUsage;
  riskScore: number;
}

export interface UsagePanelState {
  rows: UsageHostRow[];
  providerAggregates: UsageProviderAggregate[];
  localCosts: AiCostSummary;
  hasCompatibleHost: boolean;
  generatedAt: number;
  staleAfterMs: number;
}

export function buildUsagePanelState(input: UsagePanelStateInput): UsagePanelState {
  const snapshots = input.snapshots;
  const refreshing = toIdSet(input.refreshingHostIds);
  const rows = input.hosts.map((host) => {
    const connectionState = readMapLike(input.connectionStates, host.id) ?? 'Idle';
    const snapshot = snapshots ? readMapLike(snapshots, host.id) : undefined;
    const summary = snapshot?.summary;
    const lastRefreshAt = snapshot?.lastRefreshAt ?? newestProviderTimestamp(summary);
    const stale = lastRefreshAt !== undefined && input.now - lastRefreshAt > input.staleAfterMs;
    const providers = summary?.providers ?? [];

    return {
      hostId: host.id,
      hostName: host.name || host.hostname,
      address: formatAddress(host),
      connectionState,
      status: resolveRowStatus({
        usageEnabled: input.usageEnabled ?? true,
        host,
        connectionState,
        refreshing: refreshing.has(host.id),
        snapshot,
        hasSummary: summary !== undefined,
        stale,
      }),
      providers,
      totalCostUsd: summary?.totalCostUsd ?? 0,
      currency: summary?.currency ?? 'USD',
      lastRefreshAt,
      stale,
      errorText: snapshot?.errorText,
      blockedReason: snapshot?.blockedReason,
    };
  });

  return {
    rows,
    providerAggregates: aggregateWorstProviderRows(rows),
    localCosts: summarizeAiCosts(input.localCostRecords ?? []),
    hasCompatibleHost: rows.some((row) => row.status === 'ready' || row.status === 'stale' || row.status === 'refreshing'),
    generatedAt: input.now,
    staleAfterMs: input.staleAfterMs,
  };
}

export function aggregateWorstProviderRows(rows: readonly UsageHostRow[]): UsageProviderAggregate[] {
  const byProvider = new Map<string, UsageProviderAggregate>();

  for (const row of rows) {
    if (row.status !== 'ready' && row.status !== 'stale') {
      continue;
    }
    for (const usage of row.providers) {
      const key = usage.provider.toLowerCase();
      const aggregate: UsageProviderAggregate = {
        provider: usage.provider,
        hostId: row.hostId,
        hostName: row.hostName,
        usage,
        riskScore: providerRiskScore(usage),
      };
      const existing = byProvider.get(key);
      if (!existing || aggregate.riskScore > existing.riskScore) {
        byProvider.set(key, aggregate);
      }
    }
  }

  return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

export function renderUsagePanelState(state: UsagePanelState): string {
  const lines: string[] = [];
  lines.push('# PocketShell Usage');
  lines.push(`generated: ${formatTimestamp(state.generatedAt)}`);
  lines.push('');

  lines.push('## Providers');
  if (state.providerAggregates.length === 0) {
    lines.push('(no provider usage from compatible connected hosts)');
  } else {
    for (const aggregate of state.providerAggregates) {
      const usage = aggregate.usage;
      lines.push(
        `${usage.provider} @ ${aggregate.hostName}: tokens ${formatQuota(usage.tokensUsed, usage.tokensLimit)}, requests ${formatQuota(usage.requestsUsed, usage.requestsLimit)}, cost ${formatUsd(usage.costUsd ?? 0)}`,
      );
    }
  }
  lines.push('');

  lines.push('## Hosts');
  if (state.rows.length === 0) {
    lines.push('(no hosts configured)');
  } else {
    for (const row of state.rows) {
      const suffix = row.lastRefreshAt ? `, last refresh ${formatTimestamp(row.lastRefreshAt)}` : '';
      lines.push(`- ${row.hostName} (${row.address}) [${row.status}]${suffix}`);
      if (row.blockedReason) {
        lines.push(`  blocked: ${row.blockedReason}`);
      }
      if (row.errorText) {
        lines.push(`  error: ${row.errorText}`);
      }
      if (row.providers.length === 0) {
        lines.push('  providers: none');
      } else {
        for (const provider of row.providers) {
          lines.push(
            `  ${provider.provider}: tokens ${formatQuota(provider.tokensUsed, provider.tokensLimit)}, requests ${formatQuota(provider.requestsUsed, provider.requestsLimit)}, cost ${formatUsd(provider.costUsd ?? 0)}`,
          );
        }
      }
    }
  }
  lines.push('');

  lines.push('## Local AI Costs');
  if (state.localCosts.rows.length === 0) {
    lines.push('(no desktop-side local AI cost records)');
  } else {
    lines.push(`total: ${formatUsd(state.localCosts.totalCostUsd)}`);
    for (const row of state.localCosts.rows) {
      const model = row.model ? `/${row.model}` : '';
      lines.push(
        `${row.provider}${model} ${row.feature}: ${formatUsd(row.costUsd)} (${row.count} record(s), last ${formatTimestamp(row.lastRecordedAt)})`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function resolveRowStatus(input: {
  usageEnabled: boolean;
  host: UsagePanelHost;
  connectionState: UsageHostConnectionState;
  refreshing: boolean;
  snapshot?: UsageHostSnapshot;
  hasSummary: boolean;
  stale: boolean;
}): UsageHostRowStatus {
  if (!input.usageEnabled) {
    return 'blocked';
  }
  if (input.host.enabled === false) {
    return 'blocked';
  }
  if (input.refreshing) {
    return 'refreshing';
  }
  if (input.snapshot?.blockedReason) {
    return 'blocked';
  }
  if (input.snapshot?.errorText || input.connectionState === 'Error') {
    return 'error';
  }
  if (input.connectionState !== 'Connected') {
    return 'disconnected';
  }
  if (!input.hasSummary) {
    return 'blocked';
  }
  return input.stale ? 'stale' : 'ready';
}

function aggregateRatio(used: number, limit: number): number {
  return limit > 0 ? used / limit : 0;
}

function providerRiskScore(usage: ProviderUsage): number {
  return Math.max(
    aggregateRatio(usage.tokensUsed, usage.tokensLimit),
    aggregateRatio(usage.requestsUsed, usage.requestsLimit),
    usage.costUsd ?? 0,
  );
}

function newestProviderTimestamp(summary?: UsageSummary): number | undefined {
  if (!summary || summary.providers.length === 0) {
    return undefined;
  }
  return Math.max(...summary.providers.map((provider) => provider.updatedAt));
}

function toIdSet(ids?: ReadonlySet<number> | readonly number[]): ReadonlySet<number> {
  if (!ids) {
    return new Set();
  }
  return 'has' in ids ? ids : new Set(ids);
}

function readMapLike<T>(source: ReadonlyMap<number, T> | Record<number, T>, key: number): T | undefined {
  if ('get' in source) {
    return source.get(key);
  }
  return source[key];
}

function formatAddress(host: UsagePanelHost): string {
  const user = host.username ? `${host.username}@` : '';
  const port = host.port !== undefined ? `:${host.port}` : '';
  return `${user}${host.hostname}${port}`;
}

function formatQuota(used: number, limit: number): string {
  return limit > 0 ? `${used}/${limit}` : `${used}/unlimited`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatTimestamp(value: number): string {
  return new Date(value).toISOString();
}
