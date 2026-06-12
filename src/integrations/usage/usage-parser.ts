/**
 * Parser for `pocketshell usage` command output.
 *
 * Pure functions that convert raw CLI output into structured UsageSummary
 * objects. Handles both JSON and tabular output formats.
 */

import type { ProviderUsage, UsageSummary } from './types';

// ---------------------------------------------------------------------------
// JSON output parsing
// ---------------------------------------------------------------------------

/**
 * Shape of a single provider entry in JSON output from `pocketshell usage`.
 */
interface RawProviderEntry {
  provider?: string;
  tokens_used?: number;
  tokens_limit?: number;
  requests_used?: number;
  requests_limit?: number;
  cost_usd?: number;
  period?: string;
}

/**
 * Shape of JSON output from `pocketshell usage --json`.
 */
interface RawUsageJson {
  providers?: RawProviderEntry[];
  total_cost_usd?: number;
  currency?: string;
}

/**
 * Parse JSON output from `pocketshell usage`.
 */
function parseJsonOutput(json: RawUsageJson): UsageSummary {
  const now = Date.now();
  const providers: ProviderUsage[] = (json.providers ?? []).map((entry) => ({
    provider: entry.provider ?? 'unknown',
    tokensUsed: entry.tokens_used ?? 0,
    tokensLimit: entry.tokens_limit ?? 0,
    requestsUsed: entry.requests_used ?? 0,
    requestsLimit: entry.requests_limit ?? 0,
    costUsd: entry.cost_usd,
    period: entry.period ?? '',
    updatedAt: now,
  }));

  const totalCostUsd = json.total_cost_usd ?? providers.reduce(
    (sum, p) => sum + (p.costUsd ?? 0),
    0,
  );

  return {
    providers,
    totalCostUsd,
    currency: json.currency ?? 'USD',
  };
}

// ---------------------------------------------------------------------------
// Table output parsing
// ---------------------------------------------------------------------------

/**
 * Parse tabular output from `pocketshell usage`.
 *
 * Expected format (columnar, space-separated):
 * ```
 * PROVIDER   TOKENS_USED  TOKENS_LIMIT  REQUESTS_USED  REQUESTS_LIMIT  COST_USD  PERIOD
 * anthropic  15000        100000        45             500             1.23      2026-06
 * openai     8000         50000         20             200             0.87      2026-06
 * ```
 *
 * The header line is optional. Lines starting with '#' or empty lines are skipped.
 */
function parseTableOutput(text: string): UsageSummary {
  const now = Date.now();
  const lines = text.split('\n').filter(
    (line) => line.trim().length > 0 && !line.trimStart().startsWith('#'),
  );

  if (lines.length === 0) {
    return { providers: [], totalCostUsd: 0, currency: 'USD' };
  }

  // Detect and skip header line
  const firstLine = lines[0].toLowerCase();
  const startIndex = firstLine.includes('provider') ? 1 : 0;

  const providers: ProviderUsage[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length < 7) continue;

    const costUsd = parseFloat(parts[5]);
    providers.push({
      provider: parts[0],
      tokensUsed: parseInt(parts[1], 10) || 0,
      tokensLimit: parseInt(parts[2], 10) || 0,
      requestsUsed: parseInt(parts[3], 10) || 0,
      requestsLimit: parseInt(parts[4], 10) || 0,
      costUsd: isNaN(costUsd) ? undefined : costUsd,
      period: parts[6],
      updatedAt: now,
    });
  }

  const totalCostUsd = providers.reduce(
    (sum, p) => sum + (p.costUsd ?? 0),
    0,
  );

  return {
    providers,
    totalCostUsd,
    currency: 'USD',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse raw output from `pocketshell usage` into a UsageSummary.
 *
 * Attempts JSON parsing first. If that fails, falls back to table parsing.
 * Returns an empty summary for empty or whitespace-only input.
 */
export function parseUsageOutput(output: string): UsageSummary {
  const trimmed = output.trim();

  if (trimmed.length === 0) {
    return { providers: [], totalCostUsd: 0, currency: 'USD' };
  }

  // Try JSON first
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed);
      return parseJsonOutput(json);
    } catch {
      // Fall through to table parser
    }
  }

  // Fall back to table parsing
  return parseTableOutput(trimmed);
}
