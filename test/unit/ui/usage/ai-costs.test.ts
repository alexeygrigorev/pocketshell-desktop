import { describe, expect, it } from 'vitest';
import { AiCostRecorder, createAiCostRecord, summarizeAiCosts } from '../../../../src/ui/usage';

describe('AI cost tracking', () => {
  it('creates Android-compatible desktop records without provider dependencies', () => {
    const record = createAiCostRecord({
      timestampMillis: 1_800_000_000_000,
      provider: 'openai',
      feature: 'whisper-transcription',
      model: 'whisper-1',
      inputUnits: 120,
      outputUnits: 0,
      unitCostUsdMillicents: 600,
      metadataJson: '{"durationSeconds":120}',
    });

    expect(record).toMatchObject({
      timestampMillis: 1_800_000_000_000,
      provider: 'openai',
      feature: 'whisper-transcription',
      model: 'whisper-1',
      inputUnits: 120,
      outputUnits: 0,
      unitCostUsdMillicents: 600,
      computedCostUsdMillicents: 72_000,
      metadataJson: '{"durationSeconds":120}',
    });
  });

  it('summarizes costs by provider, feature, and model', () => {
    const summary = summarizeAiCosts([
      createAiCostRecord({
        timestampMillis: 100,
        provider: 'openai',
        feature: 'transcribe',
        model: 'whisper-1',
        inputUnits: 10,
        unitCostUsdMillicents: 100,
      }),
      createAiCostRecord({
        timestampMillis: 200,
        provider: 'openai',
        feature: 'transcribe',
        model: 'whisper-1',
        inputUnits: 15,
        outputUnits: 5,
        unitCostUsdMillicents: 100,
      }),
    ]);

    expect(summary.totalCostUsdMillicents).toBe(3_000);
    expect(summary.totalCostUsd).toBe(0.03);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]).toMatchObject({
      provider: 'openai',
      feature: 'transcribe',
      model: 'whisper-1',
      inputUnits: 25,
      outputUnits: 5,
      costUsdMillicents: 3_000,
      count: 2,
      lastRecordedAt: 200,
    });
  });

  it('ignores sink failures so cost recording stays best-effort', async () => {
    const recorder = new AiCostRecorder(() => {
      throw new Error('disk full');
    });

    await expect(recorder.record({
      timestampMillis: 100,
      provider: 'openai',
      feature: 'transcribe',
      inputUnits: 1,
      unitCostUsdMillicents: 100,
    })).resolves.toMatchObject({ computedCostUsdMillicents: 100 });
    expect(recorder.list()).toHaveLength(1);
  });
});
