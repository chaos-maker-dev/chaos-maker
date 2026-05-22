import { describe, it, expect } from 'vitest';
import {
  MatcherRegistry,
  resolveNamedMatchers,
  ruleMatcherOrigin,
  BUILT_IN_MATCHERS,
} from '../src/matchers';
import { prepareChaosConfig } from '../src/validation';
import { ChaosConfigError } from '../src/errors';
import type { ChaosConfig } from '../src/config';

const BUILT_IN_NAMES = ['graphql', 'apiRequests', 'authRequests'] as const;

describe('BUILT_IN_MATCHERS catalog', () => {
  it('exposes exactly the three documented built-ins', () => {
    expect(BUILT_IN_MATCHERS.map((e) => e.name).sort()).toEqual(
      [...BUILT_IN_NAMES].sort(),
    );
  });

  it('defines each built-in with the documented config', () => {
    const byName = new Map(BUILT_IN_MATCHERS.map((e) => [e.name, e.config]));
    expect(byName.get('graphql')).toEqual({ urlPattern: '/graphql' });
    expect(byName.get('apiRequests')).toEqual({ urlPattern: '/api' });
    expect(byName.get('authRequests')).toEqual({
      requestHeaders: { authorization: true },
    });
  });

  it('freezes the array, every descriptor, and every config', () => {
    expect(Object.isFrozen(BUILT_IN_MATCHERS)).toBe(true);
    for (const entry of BUILT_IN_MATCHERS) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.config)).toBe(true);
    }
  });
});

describe('MatcherRegistry: built-in fallback', () => {
  it('resolves built-in names on an otherwise empty registry', () => {
    const r = new MatcherRegistry();
    for (const name of BUILT_IN_NAMES) {
      expect(r.has(name)).toBe(true);
    }
    expect(r.get('graphql')).toEqual({ urlPattern: '/graphql' });
    expect(r.get('apiRequests')).toEqual({ urlPattern: '/api' });
    expect(r.get('authRequests')).toEqual({
      requestHeaders: { authorization: true },
    });
  });

  it('list includes built-ins; listBuiltIns returns only built-ins', () => {
    const r = new MatcherRegistry();
    expect(r.list()).toEqual(expect.arrayContaining([...BUILT_IN_NAMES]));
    expect(r.listBuiltIns().sort()).toEqual([...BUILT_IN_NAMES].sort());
  });

  it('list deduplicates a user override of a built-in name', () => {
    const r = new MatcherRegistry();
    r.register({ name: 'graphql', config: { urlPattern: '/custom' } });
    expect(r.list().filter((n) => n === 'graphql')).toEqual(['graphql']);
  });

  it('a user entry shadows the built-in of the same name', () => {
    const r = new MatcherRegistry();
    r.register({ name: 'graphql', config: { urlPattern: '/custom-gql' } });
    expect(r.get('graphql')).toEqual({ urlPattern: '/custom-gql' });
  });

  it('registering a built-in name does not throw (built-ins are overridable)', () => {
    const r = new MatcherRegistry();
    expect(() =>
      r.register({ name: 'apiRequests', config: { urlPattern: '/v2' } }),
    ).not.toThrow();
  });

  it('still throws on a genuine user-vs-user duplicate', () => {
    const r = new MatcherRegistry();
    r.register({ name: 'mine', config: { urlPattern: '/x' } });
    expect(() =>
      r.register({ name: 'mine', config: { urlPattern: '/y' } }),
    ).toThrow(/already registered/);
  });

  it('get on a truly unknown name lists the built-ins in the error', () => {
    const r = new MatcherRegistry();
    for (const name of BUILT_IN_NAMES) {
      expect(() => r.get('nope')).toThrow(new RegExp(name));
    }
  });

  it('returns a frozen, immutable built-in config', () => {
    const cfg = new MatcherRegistry().get('graphql');
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(() => {
      (cfg as { urlPattern?: string }).urlPattern = 'mutated';
    }).toThrow();
  });
});

describe('resolveNamedMatchers: built-in resolution', () => {
  it.each(BUILT_IN_NAMES)(
    'inlines built-in %s into a network rule with no matchers field declared',
    (name) => {
      const cfg: ChaosConfig = {
        network: {
          failures: [{ matcher: name, statusCode: 503, probability: 1 } as never],
        },
      };
      const out = resolveNamedMatchers(cfg, new MatcherRegistry());
      const failure = out.network!.failures![0] as Record<string, unknown>;
      expect(failure.matcher).toBeUndefined();
      expect(failure.statusCode).toBe(503);
      expect(ruleMatcherOrigin.get(failure)).toBe(name);
    },
  );

  it('inlines the graphql urlPattern onto the rule', () => {
    const cfg: ChaosConfig = {
      network: {
        latencies: [{ matcher: 'graphql', delayMs: 100, probability: 1 } as never],
      },
    };
    const out = resolveNamedMatchers(cfg, new MatcherRegistry());
    const latency = out.network!.latencies![0] as Record<string, unknown>;
    expect(latency.urlPattern).toBe('/graphql');
  });

  it('inlines a built-in onto WebSocket and SSE rules', () => {
    const cfg: ChaosConfig = {
      websocket: {
        drops: [{ matcher: 'graphql', direction: 'inbound', probability: 1 } as never],
      },
      sse: {
        drops: [{ matcher: 'apiRequests', probability: 1 } as never],
      },
    };
    const out = resolveNamedMatchers(cfg, new MatcherRegistry());
    expect((out.websocket!.drops![0] as Record<string, unknown>).urlPattern).toBe(
      '/graphql',
    );
    expect((out.sse!.drops![0] as Record<string, unknown>).urlPattern).toBe('/api');
  });

  it('inlines authRequests onto a WebSocket rule without throwing (gate ignores requestHeaders)', () => {
    const cfg: ChaosConfig = {
      websocket: {
        drops: [
          { matcher: 'authRequests', direction: 'inbound', probability: 1 } as never,
        ],
      },
    };
    const out = resolveNamedMatchers(cfg, new MatcherRegistry());
    const drop = out.websocket!.drops![0] as Record<string, unknown>;
    expect(drop.requestHeaders).toEqual({ authorization: true });
    expect(drop.matcher).toBeUndefined();
  });

  it('does not mutate the shared built-in config when resolving', () => {
    const cfg: ChaosConfig = {
      network: {
        failures: [{ matcher: 'graphql', statusCode: 500, probability: 1 } as never],
      },
    };
    resolveNamedMatchers(cfg, new MatcherRegistry());
    expect(new MatcherRegistry().get('graphql')).toEqual({ urlPattern: '/graphql' });
  });

  it('resolves deterministically across repeated runs', () => {
    const make = (): ChaosConfig => ({
      network: {
        failures: [{ matcher: 'graphql', statusCode: 503, probability: 1 } as never],
      },
    });
    const a = resolveNamedMatchers(make(), new MatcherRegistry());
    const b = resolveNamedMatchers(make(), new MatcherRegistry());
    expect(a).toEqual(b);
  });
});

describe('prepareChaosConfig: built-in matchers end to end', () => {
  it('resolves a built-in reference with no matchers field declared', () => {
    const out = prepareChaosConfig({
      network: {
        failures: [{ matcher: 'apiRequests', statusCode: 503, probability: 1 }],
      },
    });
    const f = out.network!.failures![0] as Record<string, unknown>;
    expect(f.urlPattern).toBe('/api');
    expect(f.matcher).toBeUndefined();
    expect(out.matchers).toBeUndefined();
  });

  it('a user matchers entry overrides the built-in of the same name', () => {
    const out = prepareChaosConfig({
      network: {
        failures: [{ matcher: 'graphql', statusCode: 503, probability: 1 }],
      },
      matchers: { graphql: { urlPattern: '/internal/gql' } },
    });
    const f = out.network!.failures![0] as Record<string, unknown>;
    expect(f.urlPattern).toBe('/internal/gql');
  });

  it('an unknown matcher still fails with matcher_not_found', () => {
    let err: unknown;
    try {
      prepareChaosConfig({
        network: {
          failures: [{ matcher: 'notABuiltIn', statusCode: 500, probability: 1 }],
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ChaosConfigError);
    expect((err as ChaosConfigError).issues[0].code).toBe('matcher_not_found');
  });
});
