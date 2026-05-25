import { describe, it, expect } from 'vitest';
import type { ChaosConfig } from '../src/config';
import { BUILT_IN_PRESETS, PresetRegistry, expandPresets } from '../src/presets';
import { prepareChaosConfig, validateConfig } from '../src/validation';
import { ChaosConfigError } from '../src/errors';

describe('expandPresets', () => {
  it('returns a fresh ChaosConfig  -  caller owns the result', () => {
    const input: ChaosConfig = { presets: ['slow-api'] };
    const out = expandPresets(input, new PresetRegistry());
    expect(out).not.toBe(input);
    expect(out.presets).toBeUndefined();
    expect(out.customPresets).toBeUndefined();
  });

  it('mutating the result does not affect the input', () => {
    const input: ChaosConfig = {
      network: { failures: [{ urlPattern: '/api', statusCode: 500, probability: 1 }] },
    };
    const out = expandPresets(input, new PresetRegistry());
    out.network!.failures!.push({ urlPattern: '/x', statusCode: 503, probability: 1 });
    expect(input.network!.failures).toHaveLength(1);
  });

  it('strips presets and customPresets even when presets[] is empty', () => {
    const input: ChaosConfig = {
      customPresets: { 'team-flow': {} },
      network: { latencies: [{ urlPattern: '/api', delayMs: 100, probability: 1 }] },
    };
    const out = expandPresets(input, new PresetRegistry());
    expect(out.presets).toBeUndefined();
    expect(out.customPresets).toBeUndefined();
    expect(out.network!.latencies).toHaveLength(1);
  });

  it('expands a single built-in preset, appending preset rules first then user rules', () => {
    const input: ChaosConfig = {
      presets: ['slow-api'],
      network: {
        latencies: [{ urlPattern: '/user', delayMs: 50, probability: 1 }],
      },
    };
    const out = expandPresets(input, new PresetRegistry());
    expect(out.network!.latencies).toHaveLength(2);
    expect(out.network!.latencies![0].urlPattern).toBe('*');
    expect(out.network!.latencies![0].delayMs).toBe(2000);
    expect(out.network!.latencies![1].urlPattern).toBe('/user');
  });

  it('appends multiple presets in the order listed', () => {
    const input: ChaosConfig = { presets: ['slowNetwork', 'unstableApi'] };
    const out = expandPresets(input, new PresetRegistry());
    expect(out.network!.latencies![0].urlPattern).toBe('*');
    expect(out.network!.latencies![1].urlPattern).toBe('/api/');
  });

  it('camelCase + kebab name resolve to identical rules', () => {
    const a = expandPresets({ presets: ['slow-api'] }, new PresetRegistry());
    const b = expandPresets({ presets: ['slowNetwork'] }, new PresetRegistry());
    expect(a.network!.latencies).toEqual(b.network!.latencies);
  });

  it('dedupes preset names preserving first occurrence', () => {
    const out = expandPresets({ presets: ['slow-api', 'slow-api', 'slow-api'] }, new PresetRegistry());
    expect(out.network!.latencies).toHaveLength(1);
  });

  it('dedupes aliases pointing at the same built-in config (identity dedup)', () => {
    const out = expandPresets({ presets: ['slow-api', 'slowNetwork'] }, new PresetRegistry());
    expect(out.network!.latencies).toHaveLength(1);
  });

  it('alias dedup preserves first-occurrence order across distinct presets', () => {
    const out = expandPresets(
      { presets: ['slowNetwork', 'flaky-api', 'slow-api'] },
      new PresetRegistry(),
    );
    // slow-api collapses into the prior slowNetwork; flaky-api stays.
    // slowNetwork latency at index 0, flaky-api latency at index 1.
    expect(out.network!.latencies).toHaveLength(2);
    expect(out.network!.latencies![0].delayMs).toBe(2000);
    expect(out.network!.latencies![1].delayMs).toBe(3000);
  });

  it('does not dedup distinct customs that happen to share rule shapes', () => {
    const registry = new PresetRegistry();
    registry.registerAll({
      'team-a': { network: { failures: [{ urlPattern: '/x', statusCode: 500, probability: 1 }] } },
      'team-b': { network: { failures: [{ urlPattern: '/x', statusCode: 500, probability: 1 }] } },
    });
    const out = expandPresets({ presets: ['team-a', 'team-b'] }, registry);
    expect(out.network!.failures).toHaveLength(2);
  });

  it('does not mutate BUILT_IN_PRESETS', () => {
    const before = BUILT_IN_PRESETS.length;
    expandPresets({ presets: ['slow-api'] }, new PresetRegistry());
    expect(BUILT_IN_PRESETS.length).toBe(before);
    expect(Object.isFrozen(BUILT_IN_PRESETS)).toBe(true);
  });

  it('throws on unknown preset name', () => {
    expect(() => expandPresets({ presets: ['nope'] }, new PresetRegistry())).toThrow(/'nope' is not registered/);
  });

  it('preserves RegExp matchers from custom presets via cloneValue', () => {
    const registry = new PresetRegistry();
    registry.registerAll({
      'gql-team': {
        network: {
          failures: [
            { urlPattern: '/graphql', statusCode: 500, probability: 1, graphqlOperation: /^Get/ },
          ],
        },
      },
    });
    const out = expandPresets({ presets: ['gql-team'] }, registry);
    const matcher = out.network!.failures![0].graphqlOperation;
    expect(matcher).toBeInstanceOf(RegExp);
    expect((matcher as RegExp).source).toBe('^Get');
  });

  it('appendSlice fail-fast on non-array sub-key inside a registered preset', () => {
    const registry = new PresetRegistry([]);
    registry.register({
      name: 'broken',
       
      config: { network: { failures: 'oops' as any } },
    });
    expect(() => expandPresets({ presets: ['broken'] }, registry)).toThrow(/must be an array/);
  });

  it('expands mobile-3g into network latency + abort rules', () => {
    const out = expandPresets({ presets: ['mobile-3g'] }, new PresetRegistry());
    expect(out.network!.latencies).toHaveLength(1);
    expect(out.network!.latencies![0]).toEqual({ urlPattern: '*', delayMs: 1500, probability: 1.0 });
    expect(out.network!.aborts).toHaveLength(1);
    expect(out.network!.aborts![0]).toEqual({ urlPattern: '*', probability: 0.02 });
  });

  it('expands checkout-degraded into scoped latency + failure rules', () => {
    const out = expandPresets({ presets: ['checkout-degraded'] }, new PresetRegistry());
    expect(out.network!.latencies?.[0].urlPattern).toBe('/checkout');
    expect(out.network!.failures).toHaveLength(2);
    expect(out.network!.failures![0]).toMatchObject({ urlPattern: '/checkout', statusCode: 503 });
    expect(out.network!.failures![1]).toMatchObject({ urlPattern: '/api/payments', statusCode: 500 });
  });

  it('concatenates new presets in declared order', () => {
    const out = expandPresets({ presets: ['mobile-3g', 'checkout-degraded'] }, new PresetRegistry());
    expect(out.network!.latencies?.[0].urlPattern).toBe('*');
    expect(out.network!.latencies?.[1].urlPattern).toBe('/checkout');
    expect(out.network!.failures).toHaveLength(2);
    expect(out.network!.aborts).toHaveLength(1);
  });

  it('alias dedup: websocket-instability and unreliableWebSocket collapse to one expansion', () => {
    const out = expandPresets(
      { presets: ['websocket-instability', 'unreliableWebSocket'] },
      new PresetRegistry(),
    );
    expect(out.websocket!.drops).toHaveLength(1);
    expect(out.websocket!.delays).toHaveLength(1);
    expect(out.websocket!.corruptions).toHaveLength(1);
  });

  it('alias dedup: realtime-lag and unreliableEventStream collapse to one expansion', () => {
    const out = expandPresets(
      { presets: ['realtime-lag', 'unreliableEventStream'] },
      new PresetRegistry(),
    );
    expect(out.sse!.drops).toHaveLength(1);
    expect(out.sse!.delays).toHaveLength(1);
    expect(out.sse!.closes).toHaveLength(1);
  });

  it('alias dedup: api-flaky and flakyConnection collapse to one expansion', () => {
    const out = expandPresets(
      { presets: ['api-flaky', 'flakyConnection'] },
      new PresetRegistry(),
    );
    expect(out.network!.aborts).toHaveLength(1);
    expect(out.network!.latencies).toHaveLength(1);
  });

  it('concatenates groups across preset and user', () => {
    const registry = new PresetRegistry();
    registry.registerAll({
      'team-flow': {
        groups: [{ name: 'preset-side' }],
        network: {
          failures: [{ urlPattern: '/x', statusCode: 503, probability: 1, group: 'preset-side' }],
        },
      },
    });
    const out = expandPresets(
      {
        presets: ['team-flow'],
        groups: [{ name: 'user-side' }],
      },
      registry,
    );
    expect(out.groups?.map((g) => g.name)).toEqual(['preset-side', 'user-side']);
  });
});

describe('prepareChaosConfig', () => {
  it('runs the full pipeline (validate → register → expand → revalidate)', () => {
    const out = prepareChaosConfig({ presets: ['slow-api'] });
    expect(out.network!.latencies).toHaveLength(1);
    expect(out.presets).toBeUndefined();
    expect(out.customPresets).toBeUndefined();
  });

  it('throws ChaosConfigError on unknown preset name', () => {
    expect(() => prepareChaosConfig({ presets: ['nope'] })).toThrow(ChaosConfigError);
  });

  it('throws ChaosConfigError when customPresets carries a chain (presets field)', () => {
    expect(() =>
      prepareChaosConfig({
         
        customPresets: { x: { presets: ['y'] } as any },
      }),
    ).toThrow(ChaosConfigError);
  });

  it('throws ChaosConfigError when customPresets carries seed (forbidden subfield)', () => {
    expect(() =>
      prepareChaosConfig({
         
        customPresets: { x: { seed: 1 } as any },
      }),
    ).toThrow(ChaosConfigError);
  });

  it('throws ChaosConfigError on customPresets vs built-in collision', () => {
    expect(() =>
      prepareChaosConfig({ customPresets: { slowNetwork: {} } }),
    ).toThrow(/already registered/);
  });

  it('runs the post-merge Zod pass  -  group-name collision across preset+user fails', () => {
    let caught: unknown;
    try {
      prepareChaosConfig({
        customPresets: {
          'team-flow': {
            groups: [{ name: 'payments' }],
          },
        },
        presets: ['team-flow'],
        groups: [{ name: 'payments' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ChaosConfigError);
    expect((caught as ChaosConfigError).message).toMatch(/duplicate group name/);
  });

  it('canonical-entry-point asymmetry: validateConfig keeps preset fields, prepareChaosConfig strips them', () => {
    const input = { presets: ['slow-api'] };
    const validated = validateConfig(input);
    expect(validated.presets).toEqual(['slow-api']);
    const prepared = prepareChaosConfig(input);
    expect(prepared.presets).toBeUndefined();
    expect(prepared.customPresets).toBeUndefined();
  });
});
