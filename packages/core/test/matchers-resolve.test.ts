import { describe, it, expect } from 'vitest';
import type { ChaosConfig } from '../src/config';
import {
  MatcherRegistry,
  resolveNamedMatchers,
  ruleMatcherOrigin,
} from '../src/matchers';

describe('MatcherRegistry', () => {
  it('register stores by trimmed name', () => {
    const r = new MatcherRegistry();
    r.register({ name: '  customers ', config: { urlPattern: '/api/customers' } });
    expect(r.has('customers')).toBe(true);
    expect(r.get('customers').urlPattern).toBe('/api/customers');
    expect(r.list()).toEqual(['customers']);
  });

  it('register throws on duplicate name', () => {
    const r = new MatcherRegistry();
    r.register({ name: 'a', config: { urlPattern: '/x' } });
    expect(() => r.register({ name: 'a', config: { urlPattern: '/y' } })).toThrow(
      /already registered/,
    );
  });

  it('register throws on empty name', () => {
    const r = new MatcherRegistry();
    expect(() => r.register({ name: '   ', config: { urlPattern: '/x' } })).toThrow(
      /matcher name cannot be empty/,
    );
  });

  it('get throws when name missing', () => {
    const r = new MatcherRegistry();
    expect(() => r.get('absent')).toThrow(/is not registered/);
  });

  it('registerAll seeds from a record', () => {
    const r = new MatcherRegistry();
    r.registerAll({
      a: { urlPattern: '/x' },
      b: { hostname: 'api.example.com' },
    });
    expect(r.list().sort()).toEqual(['a', 'b']);
  });
});

describe('resolveNamedMatchers', () => {
  function makeConfig(overrides?: Partial<ChaosConfig>): ChaosConfig {
    return {
      network: {
        failures: [
          { matcher: 'customers', statusCode: 503, probability: 1 } as never,
        ],
        latencies: [
          { urlPattern: '/api/orders', delayMs: 100, probability: 1 },
        ],
      },
      matchers: {
        customers: { urlPattern: '/api/customers', methods: ['GET'] },
      },
      ...overrides,
    };
  }

  it('inlines registered fields into the rule and strips matcher key', () => {
    const cfg = makeConfig();
    const registry = new MatcherRegistry();
    registry.registerAll(cfg.matchers);
    const out = resolveNamedMatchers(cfg, registry);
    const failure = out.network!.failures![0] as Record<string, unknown>;
    expect(failure.urlPattern).toBe('/api/customers');
    expect(failure.methods).toEqual(['GET']);
    expect(failure.matcher).toBeUndefined();
    expect(failure.statusCode).toBe(503);
  });

  it('leaves rules without matcher field untouched', () => {
    const cfg = makeConfig();
    const registry = new MatcherRegistry();
    registry.registerAll(cfg.matchers);
    const out = resolveNamedMatchers(cfg, registry);
    expect(out.network!.latencies![0].urlPattern).toBe('/api/orders');
  });

  it('returns a fresh config with matchers field stripped', () => {
    const cfg = makeConfig();
    const registry = new MatcherRegistry();
    registry.registerAll(cfg.matchers);
    const out = resolveNamedMatchers(cfg, registry);
    expect(out).not.toBe(cfg);
    expect(out.matchers).toBeUndefined();
    expect(cfg.matchers).toBeDefined();
  });

  it('stamps ruleMatcherOrigin with the matcher name', () => {
    const cfg = makeConfig();
    const registry = new MatcherRegistry();
    registry.registerAll(cfg.matchers);
    const out = resolveNamedMatchers(cfg, registry);
    const failure = out.network!.failures![0] as object;
    expect(ruleMatcherOrigin.get(failure)).toBe('customers');
  });

  it('throws when a rule references an unregistered matcher', () => {
    const cfg: ChaosConfig = {
      network: {
        failures: [
          { matcher: 'absent', statusCode: 500, probability: 1 } as never,
        ],
      },
    };
    const registry = new MatcherRegistry();
    expect(() => resolveNamedMatchers(cfg, registry)).toThrow(/is not registered/);
  });

  it('throws matcher_cycle when a registered matcher carries its own matcher field', () => {
    const cfg: ChaosConfig = {
      network: {
        failures: [
          { matcher: 'a', statusCode: 500, probability: 1 } as never,
        ],
      },
    };
    const registry = new MatcherRegistry();
    registry.register({ name: 'a', config: { matcher: 'b' } as never });
    expect(() => resolveNamedMatchers(cfg, registry)).toThrow(
      /references another matcher/,
    );
  });

  it('preserves RegExp instances during inlining', () => {
    const cfg: ChaosConfig = {
      network: {
        latencies: [
          { matcher: 'graphql', delayMs: 50, probability: 1 } as never,
        ],
      },
      matchers: {
        graphql: { urlPattern: '/graphql', graphqlOperation: /^Get/ },
      },
    };
    const registry = new MatcherRegistry();
    registry.registerAll(cfg.matchers);
    const out = resolveNamedMatchers(cfg, registry);
    const latency = out.network!.latencies![0] as Record<string, unknown>;
    expect(latency.graphqlOperation).toBeInstanceOf(RegExp);
    expect((latency.graphqlOperation as RegExp).source).toBe('^Get');
  });

  it('returns the config unchanged when no network rules carry matcher refs', () => {
    const cfg: ChaosConfig = {
      network: {
        latencies: [{ urlPattern: '/x', delayMs: 10, probability: 1 }],
      },
    };
    const registry = new MatcherRegistry();
    const out = resolveNamedMatchers(cfg, registry);
    expect(out.network!.latencies![0].urlPattern).toBe('/x');
  });
});
