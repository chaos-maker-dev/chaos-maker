import { describe, it, expect } from 'vitest';
import { compileAiToRules, AI_TRANSLATIONS } from '../src/ai';
import { prepareChaosConfig } from '../src/validation';
import { createPrng } from '../src/prng';
import type { AiConfig, ChaosConfig } from '../src/config';

describe('AI compiler: AI_TRANSLATIONS drift guard', () => {
  it('covers every AiConfig field exactly once', () => {
    // Build a synthetic AiConfig sample so `Object.keys` reflects every
    // declared field. Any new AiConfig field added without a matching
    // translation row trips this test.
    const sample: Required<AiConfig> = {
      firstChunkDelayMs: 0,
      pauseAfterChunk: 0,
      pauseDurationMs: 0,
      truncateAfterChunk: 0,
      duplicateChunkProbability: 0,
      reconnectAfterDrop: false,
      transport: 'auto',
    };
    const sampleKeys = Object.keys(sample).sort();
    const tableKeys = AI_TRANSLATIONS.map((t) => t.aiField).sort();
    expect(tableKeys).toEqual(sampleKeys);
  });

  it('every translation row carries a non-empty description', () => {
    for (const row of AI_TRANSLATIONS) {
      expect(typeof row.description).toBe('string');
      expect(row.description.length).toBeGreaterThan(0);
    }
  });
});

describe('AI compiler: firstChunkDelayMs', () => {
  it('compiles into a chunkIndex: 0 delay on fetchStream under transport: auto', () => {
    const cfg: ChaosConfig = { ai: { firstChunkDelayMs: 750 } };
    compileAiToRules(cfg);
    expect(cfg.ai).toBeUndefined();
    expect(cfg.fetchStream?.delays?.length).toBe(1);
    expect(cfg.fetchStream!.delays![0]).toMatchObject({
      urlPattern: '*',
      chunkIndex: 0,
      delayMs: 750,
      probability: 1,
    });
  });

  it('compiles into onNth: 1 on sse and ws inbound under transport: auto', () => {
    const cfg: ChaosConfig = { ai: { firstChunkDelayMs: 500 } };
    compileAiToRules(cfg);
    expect(cfg.sse?.delays?.[0]).toMatchObject({ onNth: 1, delayMs: 500, probability: 1 });
    expect(cfg.websocket?.delays?.[0]).toMatchObject({
      direction: 'inbound',
      onNth: 1,
      delayMs: 500,
      probability: 1,
    });
  });

  it('emits rules only into the explicit transport', () => {
    const cfg: ChaosConfig = { ai: { firstChunkDelayMs: 100, transport: 'fetch-stream' } };
    compileAiToRules(cfg);
    expect(cfg.fetchStream?.delays?.length).toBe(1);
    expect(cfg.sse).toBeUndefined();
    expect(cfg.websocket).toBeUndefined();
  });
});

describe('AI compiler: pauseAfterChunk + pauseDurationMs', () => {
  it('compiles into a chunkIndex: K delay on fetchStream', () => {
    const cfg: ChaosConfig = { ai: { pauseAfterChunk: 4, pauseDurationMs: 2000 } };
    compileAiToRules(cfg);
    expect(cfg.fetchStream?.delays?.[0]).toMatchObject({
      chunkIndex: 4,
      delayMs: 2000,
      probability: 1,
    });
  });

  it('compiles into onNth: K + 1 on sse + ws', () => {
    const cfg: ChaosConfig = { ai: { pauseAfterChunk: 4, pauseDurationMs: 2000, transport: 'sse' } };
    compileAiToRules(cfg);
    expect(cfg.sse?.delays?.[0]).toMatchObject({ onNth: 5, delayMs: 2000 });
  });
});

describe('AI compiler: truncateAfterChunk', () => {
  it('compiles into a close rule with afterChunk on fetchStream only', () => {
    const cfg: ChaosConfig = { ai: { truncateAfterChunk: 3 } };
    compileAiToRules(cfg);
    expect(cfg.fetchStream?.closes?.[0]).toMatchObject({
      urlPattern: '*',
      afterChunk: 3,
      probability: 1,
    });
    // sse + ws have no after-N-message close shape, so they get nothing.
    expect(cfg.sse?.closes).toBeUndefined();
    expect(cfg.websocket?.closes).toBeUndefined();
  });
});

describe('AI compiler: duplicateChunkProbability', () => {
  it('compiles into a duplicate corruption rule on fetchStream only', () => {
    const cfg: ChaosConfig = { ai: { duplicateChunkProbability: 0.25 } };
    compileAiToRules(cfg);
    expect(cfg.fetchStream?.corruptions?.[0]).toMatchObject({
      strategy: 'duplicate',
      probability: 0.25,
    });
    expect(cfg.sse?.corruptions).toBeUndefined();
    expect(cfg.websocket?.corruptions).toBeUndefined();
  });
});

describe('AI compiler: reconnectAfterDrop', () => {
  it('does not emit rules today but is consumed via AiCompileContext', () => {
    const cfg: ChaosConfig = { ai: { reconnectAfterDrop: true } };
    compileAiToRules(cfg);
    expect(cfg.ai).toBeUndefined();
    expect(cfg.fetchStream).toBeUndefined();
    expect(cfg.sse).toBeUndefined();
    expect(cfg.websocket).toBeUndefined();
  });
});

describe('AI compiler: composition + ordering', () => {
  it('appends rules onto already-present transport buckets without overwriting', () => {
    const cfg: ChaosConfig = {
      fetchStream: {
        drops: [{ urlPattern: '/api/legacy', probability: 0.5 }],
      },
      ai: { firstChunkDelayMs: 200, transport: 'fetch-stream' },
    };
    compileAiToRules(cfg);
    expect(cfg.fetchStream?.drops?.length).toBe(1);
    expect(cfg.fetchStream?.delays?.length).toBe(1);
  });

  it('strips config.ai after compilation', () => {
    const cfg: ChaosConfig = { ai: { firstChunkDelayMs: 100 } };
    compileAiToRules(cfg);
    expect('ai' in cfg).toBe(false);
  });
});

describe('AI compiler: prepareChaosConfig integration', () => {
  it('compiles + re-validates the merged config', () => {
    const out = prepareChaosConfig({
      ai: { firstChunkDelayMs: 500, transport: 'fetch-stream' },
    });
    expect(out.ai).toBeUndefined();
    expect(out.fetchStream?.delays?.length).toBe(1);
  });

  it('rejects malformed AI fields at the first validation pass', () => {
    expect(() =>
      prepareChaosConfig({ ai: { firstChunkDelayMs: -1 } as unknown as AiConfig }),
    ).toThrow();
  });
});

describe('PRNG sub-channel API', () => {
  it('returns a deterministic stream for the same seed + channel name', () => {
    const prng = createPrng(42);
    const a = prng.subChannel('ai:firstChunk');
    const b = prng.subChannel('ai:firstChunk');
    const sampleA = [a(), a(), a()];
    const sampleB = [b(), b(), b()];
    expect(sampleA).toEqual(sampleB);
  });

  it('returns different streams for different channel names', () => {
    const prng = createPrng(42);
    const a = prng.subChannel('ai:firstChunk');
    const b = prng.subChannel('ai:duplicate');
    expect(a()).not.toEqual(b());
  });

  it('does not perturb the parent random stream', () => {
    const prng1 = createPrng(42);
    const before = prng1.random();
    const after = prng1.random();
    const prng2 = createPrng(42);
    prng2.subChannel('ai:firstChunk')();
    const before2 = prng2.random();
    const after2 = prng2.random();
    expect(before).toBe(before2);
    expect(after).toBe(after2);
  });
});
