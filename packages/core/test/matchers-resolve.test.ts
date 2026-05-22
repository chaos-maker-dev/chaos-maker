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
    expect(r.list()).toContain('customers');
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
    expect(r.list()).toEqual(expect.arrayContaining(['a', 'b']));
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

  it('inlines matcher fields onto WebSocket rules across every category', () => {
    const cfg: ChaosConfig = {
      websocket: {
        drops: [{ matcher: 'realtime', direction: 'inbound', probability: 1 } as never],
        delays: [{ matcher: 'realtime', direction: 'outbound', delayMs: 10, probability: 1 } as never],
        corruptions: [{ matcher: 'realtime', direction: 'both', strategy: 'truncate', probability: 1 } as never],
        closes: [{ matcher: 'realtime', probability: 1 } as never],
      },
      matchers: {
        realtime: { hostname: 'realtime.example.com', queryParams: { room: 'alpha' } },
      },
    };
    const registry = new MatcherRegistry();
    registry.registerAll(cfg.matchers);
    const out = resolveNamedMatchers(cfg, registry);
    for (const cat of ['drops', 'delays', 'corruptions', 'closes'] as const) {
      const rule = out.websocket![cat]![0] as Record<string, unknown>;
      expect(rule.matcher).toBeUndefined();
      expect(rule.hostname).toBe('realtime.example.com');
      expect(rule.queryParams).toEqual({ room: 'alpha' });
      expect(ruleMatcherOrigin.get(rule)).toBe('realtime');
    }
  });

  it('inlines matcher fields onto SSE rules across every category', () => {
    const cfg: ChaosConfig = {
      sse: {
        drops: [{ matcher: 'feed', probability: 1 } as never],
        delays: [{ matcher: 'feed', delayMs: 10, probability: 1 } as never],
        corruptions: [{ matcher: 'feed', strategy: 'truncate', probability: 1 } as never],
        closes: [{ matcher: 'feed', probability: 1 } as never],
      },
      matchers: {
        feed: { hostname: 'sse.example.com', queryParams: { topic: 'alerts' } },
      },
    };
    const registry = new MatcherRegistry();
    registry.registerAll(cfg.matchers);
    const out = resolveNamedMatchers(cfg, registry);
    for (const cat of ['drops', 'delays', 'corruptions', 'closes'] as const) {
      const rule = out.sse![cat]![0] as Record<string, unknown>;
      expect(rule.matcher).toBeUndefined();
      expect(rule.hostname).toBe('sse.example.com');
      expect(rule.queryParams).toEqual({ topic: 'alerts' });
      expect(ruleMatcherOrigin.get(rule)).toBe('feed');
    }
  });

  it('inlines transport-irrelevant fields onto WS rules without throwing (gate ignores them)', () => {
    const cfg: ChaosConfig = {
      websocket: {
        drops: [{ matcher: 'shared', direction: 'inbound', probability: 1 } as never],
      },
      matchers: {
        shared: {
          hostname: 'shared.example.com',
          methods: ['POST'],
          requestHeaders: { Authorization: /^Bearer/ },
          graphqlOperation: 'GetThing',
          resourceTypes: ['fetch'],
        },
      },
    };
    const registry = new MatcherRegistry();
    registry.registerAll(cfg.matchers);
    const out = resolveNamedMatchers(cfg, registry);
    const rule = out.websocket!.drops![0] as Record<string, unknown>;
    expect(rule.hostname).toBe('shared.example.com');
    expect(rule.methods).toEqual(['POST']);
    expect(rule.requestHeaders).toBeDefined();
    expect(rule.resourceTypes).toEqual(['fetch']);
  });

  it('throws matcher_not_found for an unregistered name on a WebSocket rule', () => {
    const cfg: ChaosConfig = {
      websocket: {
        drops: [{ matcher: 'absent', direction: 'both', probability: 1 } as never],
      },
    };
    const registry = new MatcherRegistry();
    expect(() => resolveNamedMatchers(cfg, registry)).toThrow(/is not registered/);
  });

  it('throws matcher_not_found for an unregistered name on an SSE rule', () => {
    const cfg: ChaosConfig = {
      sse: {
        drops: [{ matcher: 'absent', probability: 1 } as never],
      },
    };
    const registry = new MatcherRegistry();
    expect(() => resolveNamedMatchers(cfg, registry)).toThrow(/is not registered/);
  });
});
