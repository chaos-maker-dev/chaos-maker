import { describe, expect, it } from 'vitest';
import { prepareChaosConfig } from '../src/validation';
import { matcherDetail, resolveNamedMatchers, MatcherRegistry } from '../src/matchers';
import { serializeForTransport, deserializeForTransport } from '../src/transport';
import { buildRuleIdMap } from '../src/debug';
import type { ChaosConfig } from '../src/config';

const CONFIG: ChaosConfig = {
  matchers: {
    chatApi: { urlPattern: '/api/chat' },
  },
  network: {
    failures: [{ matcher: 'chatApi', statusCode: 503, probability: 1 }],
  },
  sse: {
    delays: [{ matcher: 'chatApi', delayMs: 100, probability: 1 }],
  },
  fetchStream: {
    corruptions: [{ matcher: 'chatApi', strategy: 'malformed-json', probability: 1 }],
  },
};

describe('matcherName resolution stamp', () => {
  it('stamps a serializable matcherName onto resolved rules', () => {
    const prepared = prepareChaosConfig(CONFIG);
    expect(prepared.network!.failures![0]!.matcherName).toBe('chatApi');
    expect(prepared.sse!.delays![0]!.matcherName).toBe('chatApi');
  });

  it('resolves matcher references on fetch-stream rules', () => {
    const prepared = prepareChaosConfig(CONFIG);
    const rule = prepared.fetchStream!.corruptions![0]!;
    // The named matcher's fields are inlined and the reference is stripped.
    expect(rule.urlPattern).toBe('/api/chat');
    expect((rule as { matcher?: string }).matcher).toBeUndefined();
    expect(rule.matcherName).toBe('chatApi');
  });

  it('survives the JSON page boundary that kills the WeakMap association', () => {
    const prepared = prepareChaosConfig(CONFIG);
    // Simulate the adapter -> page hop: serialize, stringify, parse, revive.
    const wire = JSON.parse(JSON.stringify(serializeForTransport(prepared))) as ChaosConfig;
    const revived = deserializeForTransport(wire);
    const rule = revived.network!.failures![0]! as object;
    expect(matcherDetail(rule)).toEqual({ matcherName: 'chatApi' });
    const idMap = buildRuleIdMap(revived);
    expect(idMap.get(rule)?.matcherName).toBe('chatApi');
  });

  it('re-validates a stamped config cleanly (in-page constructor path)', () => {
    const prepared = prepareChaosConfig(CONFIG);
    const revived = deserializeForTransport(
      JSON.parse(JSON.stringify(serializeForTransport(prepared))) as ChaosConfig,
    );
    // ChaosMaker re-runs the full pipeline on the already-resolved config in
    // the page realm; the stamp must not trip strict validation.
    expect(() => prepareChaosConfig(revived)).not.toThrow();
    const twice = prepareChaosConfig(revived);
    expect(twice.network!.failures![0]!.matcherName).toBe('chatApi');
  });

  it('matcherDetail still reads the WeakMap for node-side rule objects', () => {
    const registry = new MatcherRegistry();
    registry.registerAll({ chatApi: { urlPattern: '/api/chat' } });
    const resolved = resolveNamedMatchers(
      { network: { failures: [{ matcher: 'chatApi', statusCode: 500, probability: 1 }] } },
      registry,
    );
    const rule = resolved.network!.failures![0]! as { matcherName?: string };
    // Strip the stamp to prove the WeakMap fallback path stays intact.
    delete rule.matcherName;
    expect(matcherDetail(rule as object)).toEqual({ matcherName: 'chatApi' });
  });
});

describe('fetch-stream rule identity', () => {
  it('assigns positional rule ids to fetch-stream rule arrays', () => {
    const config: ChaosConfig = {
      fetchStream: {
        drops: [{ urlPattern: '*', probability: 1 }],
        corruptions: [{ urlPattern: '*', strategy: 'empty', probability: 1 }],
      },
    };
    const map = buildRuleIdMap(config);
    expect(map.get(config.fetchStream!.drops![0]! as object)).toMatchObject({
      ruleType: 'fetch-stream-drop',
      ruleId: 'fetch-stream-drop#0',
    });
    expect(map.get(config.fetchStream!.corruptions![0]! as object)).toMatchObject({
      ruleType: 'fetch-stream-corrupt',
      ruleId: 'fetch-stream-corrupt#0',
    });
  });
});
