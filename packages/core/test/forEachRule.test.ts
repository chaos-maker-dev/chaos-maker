import { describe, expect, it } from 'vitest';
import { forEachRule } from '../src/utils';
import type { ChaosConfig } from '../src/config';

describe('forEachRule', () => {
  it('does not crash on empty/missing arrays', () => {
    const seen: unknown[] = [];
    forEachRule({}, (r) => seen.push(r));
    expect(seen).toEqual([]);
  });

  it('visits every rule across all 18 arrays exactly once', () => {
    // Single rule per array  -  count assertion guards future rule-array
    // additions to ChaosConfig that forget to register in forEachRule.
    const cfg: ChaosConfig = {
      network: {
        failures: [{ urlPattern: '*', statusCode: 500, probability: 1 }],
        latencies: [{ urlPattern: '*', delayMs: 1, probability: 1 }],
        aborts: [{ urlPattern: '*', probability: 1 }],
        corruptions: [{ urlPattern: '*', strategy: 'truncate', probability: 1 }],
        cors: [{ urlPattern: '*', probability: 1 }],
      },
      ui: {
        assaults: [{ selector: '.x', action: 'hide', probability: 1 }],
      },
      websocket: {
        drops: [{ urlPattern: '*', direction: 'both', probability: 1 }],
        delays: [{ urlPattern: '*', direction: 'both', delayMs: 1, probability: 1 }],
        corruptions: [{ urlPattern: '*', direction: 'both', strategy: 'truncate', probability: 1 }],
        closes: [{ urlPattern: '*', probability: 1 }],
      },
      sse: {
        drops: [{ urlPattern: '*', probability: 1 }],
        delays: [{ urlPattern: '*', delayMs: 1, probability: 1 }],
        corruptions: [{ urlPattern: '*', strategy: 'truncate', probability: 1 }],
        closes: [{ urlPattern: '*', probability: 1 }],
      },
      fetchStream: {
        drops: [{ urlPattern: '*', probability: 1 }],
        delays: [{ urlPattern: '*', delayMs: 1, probability: 1 }],
        corruptions: [{ urlPattern: '*', strategy: 'truncate', probability: 1 }],
        closes: [{ urlPattern: '*', probability: 1 }],
      },
    };
    const seen: unknown[] = [];
    forEachRule(cfg, (r) => seen.push(r));
    // 5 network + 1 ui + 4 websocket + 4 sse + 4 fetchStream = 18. If a
    // future rule array is added to ChaosConfig but not forEachRule, this
    // count breaks.
    expect(seen.length).toBe(18);
  });

  it('visits each rule object exactly once (no duplicates from shared shapes)', () => {
    const ruleA = { urlPattern: '/a', statusCode: 500, probability: 1 } as const;
    const ruleB = { urlPattern: '/b', statusCode: 503, probability: 1 } as const;
    const cfg: ChaosConfig = {
      network: { failures: [ruleA, ruleB] },
    };
    const seen = new Map<unknown, number>();
    forEachRule(cfg, (r) => seen.set(r, (seen.get(r) ?? 0) + 1));
    expect(seen.get(ruleA)).toBe(1);
    expect(seen.get(ruleB)).toBe(1);
  });

  it('threads the group field through to the callback', () => {
    const cfg: ChaosConfig = {
      network: {
        failures: [{ urlPattern: '*', statusCode: 500, probability: 1, group: 'payments' }],
      },
    };
    const groups: (string | undefined)[] = [];
    forEachRule(cfg, (r) => groups.push(r.group));
    expect(groups).toEqual(['payments']);
  });
});
