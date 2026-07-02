import { describe, it, expect } from 'vitest';
import { PresetRegistry, presets } from '../src/presets';
import { compileAiToRules } from '../src/ai';
import { prepareChaosConfig } from '../src/validation';
import type { ChaosConfig } from '../src/config';

describe('AI streaming presets: registry wiring', () => {
  it('kebab aliases share object identity with their camelCase entries', () => {
    const registry = new PresetRegistry();
    expect(registry.get('ai-slow-first-chunk')).toBe(registry.get('aiSlowFirstChunk'));
    expect(registry.get('ai-stream-truncated')).toBe(registry.get('aiStreamTruncated'));
    expect(registry.get('ai-stream-paused')).toBe(registry.get('aiStreamPaused'));
    expect(registry.get('ai-tool-call-fails')).toBe(registry.get('aiToolCallFails'));
    expect(registry.get('ai-retry-loop')).toBe(registry.get('aiRetryLoop'));
    expect(registry.get('ai-reconnect-after-drop')).toBe(registry.get('aiReconnectAfterDrop'));
    expect(registry.get('ai-mobile-interrupt')).toBe(registry.get('aiMobileInterrupt'));
  });

  it('slices are deep-frozen', () => {
    const slice = presets.aiToolCallFails!;
    expect(Object.isFrozen(slice)).toBe(true);
    expect(Object.isFrozen(slice.fetchStream!.corruptions![0])).toBe(true);
    const mobile = presets.aiMobileInterrupt!;
    expect(Object.isFrozen(mobile)).toBe(true);
    expect(Object.isFrozen(mobile.userInteraction!.tabHidden)).toBe(true);
  });
});

describe('AI streaming presets: derived slices cannot drift from the ai shorthand', () => {
  it('aiSlowFirstChunk equals compiling { ai: { firstChunkDelayMs: 3000 } }', () => {
    const compiled = compileAiToRules({ ai: { firstChunkDelayMs: 3000 } });
    expect(presets.aiSlowFirstChunk).toEqual(compiled);
  });

  it('aiStreamTruncated equals compiling { ai: { truncateAfterChunk: 20 } }', () => {
    const compiled = compileAiToRules({ ai: { truncateAfterChunk: 20 } });
    expect(presets.aiStreamTruncated).toEqual(compiled);
  });

  it('aiStreamPaused equals compiling the pause shorthand', () => {
    const compiled = compileAiToRules({ ai: { pauseAfterChunk: 10, pauseDurationMs: 5000 } });
    expect(presets.aiStreamPaused).toEqual(compiled);
  });

  it('derived slices cover all three streaming transports (auto)', () => {
    const slice = presets.aiSlowFirstChunk!;
    expect(slice.fetchStream?.delays?.length).toBeGreaterThan(0);
    expect(slice.sse?.delays?.length).toBeGreaterThan(0);
    expect(slice.websocket?.delays?.length).toBeGreaterThan(0);
  });
});

describe('AI streaming presets: full pipeline expansion', () => {
  it('expands aiToolCallFails through prepareChaosConfig with the RegExp intact', () => {
    const config = prepareChaosConfig({ presets: ['ai-tool-call-fails'], seed: 42 } as ChaosConfig);
    const rule = config.fetchStream!.corruptions![0]!;
    expect(rule.strategy).toBe('malformed-json');
    expect(rule.phase).toBe('ai:tool-call-failed');
    expect(rule.chunkPattern).toBeInstanceOf(RegExp);
    expect((rule.chunkPattern as RegExp).test('{"tool_use":{}}')).toBe(true);
  });

  it('expands aiRetryLoop into a single firstN 429 failure rule', () => {
    const config = prepareChaosConfig({ presets: ['aiRetryLoop'] } as ChaosConfig);
    const failures = config.network!.failures!;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ statusCode: 429, probability: 1, firstN: 2 });
  });

  it('expands aiReconnectAfterDrop into fetch-stream and sse close rules', () => {
    const config = prepareChaosConfig({ presets: ['ai-reconnect-after-drop'] } as ChaosConfig);
    expect(config.fetchStream!.closes![0]).toMatchObject({ afterChunk: 5, probability: 1 });
    expect(config.sse!.closes![0]).toMatchObject({ afterMs: 3000, probability: 1 });
  });

  it('expands aiMobileInterrupt into a tab-hidden trigger plus stream drops', () => {
    const config = prepareChaosConfig({ presets: ['ai-mobile-interrupt'] } as ChaosConfig);
    expect(config.userInteraction?.tabHidden).toEqual({ afterMs: 1000, durationMs: 3000 });
    expect(config.fetchStream!.closes![0]).toMatchObject({ afterChunk: 10, probability: 1 });
    expect(config.sse!.closes![0]).toMatchObject({ afterMs: 4000, probability: 1 });
  });

  it('user-set userInteraction triggers override aiMobileInterrupt per trigger', () => {
    const config = prepareChaosConfig({
      presets: ['ai-mobile-interrupt'],
      userInteraction: { tabHidden: { afterMs: 500, durationMs: 1000 }, cancelStreamAfterMs: 6000 },
    } as ChaosConfig);
    expect(config.userInteraction?.tabHidden).toEqual({ afterMs: 500, durationMs: 1000 });
    expect(config.userInteraction?.cancelStreamAfterMs).toBe(6000);
  });

  it('mixing an AI preset with a classic preset appends both rule sets', () => {
    const config = prepareChaosConfig({
      presets: ['slow-api', 'ai-slow-first-chunk'],
    } as ChaosConfig);
    // slow-api contributes a network latency; the AI preset contributes
    // streaming delays. Both survive the merge.
    expect(config.network!.latencies!.length).toBeGreaterThan(0);
    expect(config.fetchStream!.delays!.length).toBeGreaterThan(0);
  });

  it('combining an AI preset with a top-level ai shorthand keeps both rule sets', () => {
    const config = prepareChaosConfig({
      presets: ['ai-slow-first-chunk'],
      ai: { truncateAfterChunk: 8 },
    } as ChaosConfig);
    // Preset delay rule (chunkIndex 0) present, plus the ai-compiled close
    // rule from the user's shorthand.
    expect(config.fetchStream!.delays!.some((d) => d.chunkIndex === 0)).toBe(true);
    expect(config.fetchStream!.closes!.some((c) => c.afterChunk === 8)).toBe(true);
  });
});
