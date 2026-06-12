/**
 * Unit tests for usage output parser.
 *
 * Tests JSON parsing, table parsing, empty output handling,
 * and total cost computation.
 */

import { describe, it, expect } from 'vitest';
import { parseUsageOutput } from '../../../../src/integrations/usage/usage-parser';

// ---------------------------------------------------------------------------
// JSON output tests
// ---------------------------------------------------------------------------

describe('parseUsageOutput - JSON', () => {
  it('parses JSON output with multiple providers', () => {
    const json = JSON.stringify({
      providers: [
        {
          provider: 'anthropic',
          tokens_used: 15000,
          tokens_limit: 100000,
          requests_used: 45,
          requests_limit: 500,
          cost_usd: 1.23,
          period: '2026-06',
        },
        {
          provider: 'openai',
          tokens_used: 8000,
          tokens_limit: 50000,
          requests_used: 20,
          requests_limit: 200,
          cost_usd: 0.87,
          period: '2026-06',
        },
      ],
      total_cost_usd: 2.10,
      currency: 'USD',
    });

    const result = parseUsageOutput(json);

    expect(result.providers).toHaveLength(2);
    expect(result.totalCostUsd).toBeCloseTo(2.10);
    expect(result.currency).toBe('USD');

    const anthropic = result.providers[0];
    expect(anthropic.provider).toBe('anthropic');
    expect(anthropic.tokensUsed).toBe(15000);
    expect(anthropic.tokensLimit).toBe(100000);
    expect(anthropic.requestsUsed).toBe(45);
    expect(anthropic.requestsLimit).toBe(500);
    expect(anthropic.costUsd).toBeCloseTo(1.23);
    expect(anthropic.period).toBe('2026-06');
    expect(anthropic.updatedAt).toBeGreaterThan(0);

    const openai = result.providers[1];
    expect(openai.provider).toBe('openai');
    expect(openai.tokensUsed).toBe(8000);
  });

  it('parses JSON without total_cost_usd (computes from providers)', () => {
    const json = JSON.stringify({
      providers: [
        {
          provider: 'anthropic',
          tokens_used: 1000,
          tokens_limit: 10000,
          requests_used: 5,
          requests_limit: 100,
          cost_usd: 0.50,
          period: '2026-05',
        },
      ],
    });

    const result = parseUsageOutput(json);

    expect(result.totalCostUsd).toBeCloseTo(0.50);
    expect(result.currency).toBe('USD');
  });

  it('parses JSON with missing optional fields', () => {
    const json = JSON.stringify({
      providers: [
        {
          provider: 'ollama',
          tokens_used: 500,
          tokens_limit: 0,
          requests_used: 2,
          requests_limit: 0,
          period: '2026-06',
        },
      ],
    });

    const result = parseUsageOutput(json);

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].costUsd).toBeUndefined();
    expect(result.providers[0].provider).toBe('ollama');
  });

  it('parses JSON with empty providers array', () => {
    const json = JSON.stringify({ providers: [] });

    const result = parseUsageOutput(json);

    expect(result.providers).toHaveLength(0);
    expect(result.totalCostUsd).toBe(0);
    expect(result.currency).toBe('USD');
  });
});

// ---------------------------------------------------------------------------
// Table output tests
// ---------------------------------------------------------------------------

describe('parseUsageOutput - table', () => {
  it('parses table output with header', () => {
    const table = `PROVIDER  TOKENS_USED  TOKENS_LIMIT  REQUESTS_USED  REQUESTS_LIMIT  COST_USD  PERIOD
anthropic 15000 100000 45 500 1.23 2026-06
openai   8000  50000  20 200 0.87 2026-06`;

    const result = parseUsageOutput(table);

    expect(result.providers).toHaveLength(2);
    expect(result.providers[0].provider).toBe('anthropic');
    expect(result.providers[0].tokensUsed).toBe(15000);
    expect(result.providers[0].tokensLimit).toBe(100000);
    expect(result.providers[0].requestsUsed).toBe(45);
    expect(result.providers[0].requestsLimit).toBe(500);
    expect(result.providers[0].costUsd).toBeCloseTo(1.23);
    expect(result.providers[0].period).toBe('2026-06');

    expect(result.providers[1].provider).toBe('openai');
    expect(result.providers[1].tokensUsed).toBe(8000);
  });

  it('parses table output without header', () => {
    const table = `anthropic 15000 100000 45 500 1.23 2026-06`;

    const result = parseUsageOutput(table);

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].provider).toBe('anthropic');
  });

  it('skips comment lines', () => {
    const table = `# This is a comment
anthropic 15000 100000 45 500 1.23 2026-06
# Another comment`;

    const result = parseUsageOutput(table);

    expect(result.providers).toHaveLength(1);
  });

  it('skips lines with too few columns', () => {
    const table = `anthropic 15000 100000
openai 8000 50000 20 200 0.87 2026-06`;

    const result = parseUsageOutput(table);

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].provider).toBe('openai');
  });

  it('handles NaN cost as undefined', () => {
    const table = `ollama 500 0 2 0 N/A 2026-06`;

    const result = parseUsageOutput(table);

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].costUsd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Empty output tests
// ---------------------------------------------------------------------------

describe('parseUsageOutput - empty', () => {
  it('handles empty string', () => {
    const result = parseUsageOutput('');

    expect(result.providers).toHaveLength(0);
    expect(result.totalCostUsd).toBe(0);
    expect(result.currency).toBe('USD');
  });

  it('handles whitespace-only string', () => {
    const result = parseUsageOutput('   \n\n  \t  ');

    expect(result.providers).toHaveLength(0);
    expect(result.totalCostUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Total cost computation
// ---------------------------------------------------------------------------

describe('parseUsageOutput - total cost', () => {
  it('computes total cost from table providers', () => {
    const table = `PROVIDER  TOKENS_USED  TOKENS_LIMIT  REQUESTS_USED  REQUESTS_LIMIT  COST_USD  PERIOD
anthropic 15000 100000 45 500 1.50 2026-06
openai   8000  50000  20 200 0.75 2026-06
google   2000  20000  10 100 0.25 2026-06`;

    const result = parseUsageOutput(table);

    expect(result.totalCostUsd).toBeCloseTo(2.50);
    expect(result.providers).toHaveLength(3);
  });

  it('returns 0 total cost when providers have no cost', () => {
    const table = `ollama 500 0 2 0 0.00 2026-06`;

    const result = parseUsageOutput(table);

    expect(result.totalCostUsd).toBe(0);
  });

  it('sums provider costs when JSON omits total_cost_usd', () => {
    const json = JSON.stringify({
      providers: [
        { provider: 'anthropic', tokens_used: 1000, tokens_limit: 10000, requests_used: 5, requests_limit: 100, cost_usd: 3.00, period: '2026-06' },
        { provider: 'openai', tokens_used: 2000, tokens_limit: 20000, requests_used: 10, requests_limit: 200, cost_usd: 2.00, period: '2026-06' },
      ],
    });

    const result = parseUsageOutput(json);

    expect(result.totalCostUsd).toBeCloseTo(5.00);
  });
});
