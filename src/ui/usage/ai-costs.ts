/**
 * Pure desktop-side AI cost recording primitives.
 *
 * These helpers do not depend on any AI provider SDK. Callers should record
 * only successful local AI operations; failed recorder sinks are ignored so
 * cost capture never blocks the user-facing feature.
 */

export interface AiCostRecord {
  timestampMillis: number;
  provider: string;
  feature: string;
  model?: string;
  inputUnits: number;
  outputUnits: number;
  unitCostUsdMillicents: number;
  computedCostUsdMillicents: number;
  metadataJson?: string;
}

export interface AiCostInput {
  timestampMillis?: number;
  provider: string;
  feature: string;
  model?: string;
  inputUnits: number;
  outputUnits?: number;
  unitCostUsdMillicents: number;
  metadataJson?: string;
}

export interface AiCostSummaryRow {
  provider: string;
  feature: string;
  model?: string;
  inputUnits: number;
  outputUnits: number;
  costUsdMillicents: number;
  costUsd: number;
  lastRecordedAt: number;
  count: number;
}

export interface AiCostSummary {
  rows: AiCostSummaryRow[];
  totalCostUsdMillicents: number;
  totalCostUsd: number;
}

export type AiCostSink = (record: AiCostRecord) => void | Promise<void>;

export class AiCostRecorder {
  private readonly records: AiCostRecord[] = [];

  constructor(private readonly sink?: AiCostSink) {}

  async record(input: AiCostInput): Promise<AiCostRecord> {
    const record = createAiCostRecord(input);
    this.records.push(record);

    if (this.sink) {
      try {
        await this.sink(record);
      } catch {
        // Cost recording is best-effort and must not block the feature.
      }
    }

    return record;
  }

  list(): AiCostRecord[] {
    return [...this.records];
  }

  summarize(): AiCostSummary {
    return summarizeAiCosts(this.records);
  }
}

export function createAiCostRecord(input: AiCostInput): AiCostRecord {
  const outputUnits = input.outputUnits ?? 0;
  const totalUnits = input.inputUnits + outputUnits;
  return {
    timestampMillis: input.timestampMillis ?? Date.now(),
    provider: input.provider,
    feature: input.feature,
    model: input.model,
    inputUnits: input.inputUnits,
    outputUnits,
    unitCostUsdMillicents: input.unitCostUsdMillicents,
    computedCostUsdMillicents: Math.round(totalUnits * input.unitCostUsdMillicents),
    metadataJson: input.metadataJson,
  };
}

export function summarizeAiCosts(records: readonly AiCostRecord[]): AiCostSummary {
  const byKey = new Map<string, AiCostSummaryRow>();

  for (const record of records) {
    const key = [record.provider, record.feature, record.model ?? ''].join('\0');
    const existing = byKey.get(key);
    if (existing) {
      existing.inputUnits += record.inputUnits;
      existing.outputUnits += record.outputUnits;
      existing.costUsdMillicents += record.computedCostUsdMillicents;
      existing.costUsd = usdMillicentsToUsd(existing.costUsdMillicents);
      existing.lastRecordedAt = Math.max(existing.lastRecordedAt, record.timestampMillis);
      existing.count += 1;
    } else {
      byKey.set(key, {
        provider: record.provider,
        feature: record.feature,
        model: record.model,
        inputUnits: record.inputUnits,
        outputUnits: record.outputUnits,
        costUsdMillicents: record.computedCostUsdMillicents,
        costUsd: usdMillicentsToUsd(record.computedCostUsdMillicents),
        lastRecordedAt: record.timestampMillis,
        count: 1,
      });
    }
  }

  const rows = [...byKey.values()].sort((a, b) => {
    if (b.costUsdMillicents !== a.costUsdMillicents) {
      return b.costUsdMillicents - a.costUsdMillicents;
    }
    return `${a.provider}:${a.feature}:${a.model ?? ''}`.localeCompare(`${b.provider}:${b.feature}:${b.model ?? ''}`);
  });
  const totalCostUsdMillicents = rows.reduce((sum, row) => sum + row.costUsdMillicents, 0);

  return {
    rows,
    totalCostUsdMillicents,
    totalCostUsd: usdMillicentsToUsd(totalCostUsdMillicents),
  };
}

export function usdMillicentsToUsd(value: number): number {
  return value / 100_000;
}
