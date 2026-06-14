/**
 * Types for the usage/quota tracking system.
 *
 * Defines data structures for representing AI provider quota
 * information returned by the `pocketshell usage` command.
 */

// ---------------------------------------------------------------------------
// ProviderUsage
// ---------------------------------------------------------------------------

/**
 * Usage data for a single AI provider.
 */
export interface ProviderUsage {
  /** Provider identifier, e.g. 'anthropic', 'openai'. */
  provider: string;

  /** Number of tokens consumed in the current period. */
  tokensUsed: number;

  /** Token limit for the current period. */
  tokensLimit: number;

  /** Number of API requests made in the current period. */
  requestsUsed: number;

  /** Request limit for the current period. */
  requestsLimit: number;

  /** Cost in USD for the current period, if available. */
  costUsd?: number;

  /** Billing period, e.g. '2026-06'. */
  period: string;

  /** Timestamp (ms since epoch) when this data was fetched. */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// UsageSummary
// ---------------------------------------------------------------------------

/**
 * Aggregate usage summary across all providers.
 */
export interface UsageSummary {
  /** Per-provider usage data. */
  providers: ProviderUsage[];

  /** Total cost across all providers in USD. */
  totalCostUsd: number;

  /** Currency code for cost values. */
  currency: string;
}
