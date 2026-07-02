import { describe, it, expect } from 'vitest';
import { checkCountingCondition, incrementCounter } from '../src/utils';

// ---------------------------------------------------------------------------
// checkCountingCondition
// ---------------------------------------------------------------------------
describe('checkCountingCondition', () => {
  it('returns true when no counting fields are set', () => {
    expect(checkCountingCondition({}, 1)).toBe(true);
    expect(checkCountingCondition({}, 99)).toBe(true);
  });

  describe('onNth', () => {
    it('returns true only on the exact Nth count', () => {
      const rule = { onNth: 3 };
      expect(checkCountingCondition(rule, 1)).toBe(false);
      expect(checkCountingCondition(rule, 2)).toBe(false);
      expect(checkCountingCondition(rule, 3)).toBe(true);
      expect(checkCountingCondition(rule, 4)).toBe(false);
      expect(checkCountingCondition(rule, 10)).toBe(false);
    });

    it('returns true on the 1st request when onNth is 1', () => {
      const rule = { onNth: 1 };
      expect(checkCountingCondition(rule, 1)).toBe(true);
      expect(checkCountingCondition(rule, 2)).toBe(false);
    });
  });

  describe('everyNth', () => {
    it('returns true on every Nth request', () => {
      const rule = { everyNth: 3 };
      expect(checkCountingCondition(rule, 1)).toBe(false);
      expect(checkCountingCondition(rule, 2)).toBe(false);
      expect(checkCountingCondition(rule, 3)).toBe(true);
      expect(checkCountingCondition(rule, 4)).toBe(false);
      expect(checkCountingCondition(rule, 5)).toBe(false);
      expect(checkCountingCondition(rule, 6)).toBe(true);
      expect(checkCountingCondition(rule, 9)).toBe(true);
    });

    it('returns true on every 1st request when everyNth is 1', () => {
      const rule = { everyNth: 1 };
      for (let i = 1; i <= 5; i++) {
        expect(checkCountingCondition(rule, i)).toBe(true);
      }
    });

    it('returns true on every 2nd request when everyNth is 2', () => {
      const rule = { everyNth: 2 };
      expect(checkCountingCondition(rule, 1)).toBe(false);
      expect(checkCountingCondition(rule, 2)).toBe(true);
      expect(checkCountingCondition(rule, 3)).toBe(false);
      expect(checkCountingCondition(rule, 4)).toBe(true);
    });
  });

  describe('afterN', () => {
    it('returns false for the first N requests and true thereafter', () => {
      const rule = { afterN: 3 };
      expect(checkCountingCondition(rule, 1)).toBe(false);
      expect(checkCountingCondition(rule, 2)).toBe(false);
      expect(checkCountingCondition(rule, 3)).toBe(false);
      expect(checkCountingCondition(rule, 4)).toBe(true);
      expect(checkCountingCondition(rule, 10)).toBe(true);
    });

    it('fires from the very first request when afterN is 0', () => {
      const rule = { afterN: 0 };
      expect(checkCountingCondition(rule, 1)).toBe(true);
      expect(checkCountingCondition(rule, 5)).toBe(true);
    });
  });

  describe('firstN', () => {
    it('returns true for the first N requests and false thereafter', () => {
      const rule = { firstN: 2 };
      expect(checkCountingCondition(rule, 1)).toBe(true);
      expect(checkCountingCondition(rule, 2)).toBe(true);
      expect(checkCountingCondition(rule, 3)).toBe(false);
      expect(checkCountingCondition(rule, 10)).toBe(false);
    });

    it('fires only once with firstN 1', () => {
      const rule = { firstN: 1 };
      expect(checkCountingCondition(rule, 1)).toBe(true);
      expect(checkCountingCondition(rule, 2)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// incrementCounter
// ---------------------------------------------------------------------------
describe('incrementCounter', () => {
  it('starts at 1 for a new rule', () => {
    const counters = new Map<object, number>();
    const rule = {};
    expect(incrementCounter(rule, counters)).toBe(1);
  });

  it('increments on each call', () => {
    const counters = new Map<object, number>();
    const rule = {};
    expect(incrementCounter(rule, counters)).toBe(1);
    expect(incrementCounter(rule, counters)).toBe(2);
    expect(incrementCounter(rule, counters)).toBe(3);
  });

  it('tracks different rules independently', () => {
    const counters = new Map<object, number>();
    const ruleA = {};
    const ruleB = {};
    incrementCounter(ruleA, counters);
    incrementCounter(ruleA, counters);
    incrementCounter(ruleB, counters);
    expect(incrementCounter(ruleA, counters)).toBe(3);
    expect(incrementCounter(ruleB, counters)).toBe(2);
  });

  it('uses object reference as the key  -  same ref means same counter', () => {
    const counters = new Map<object, number>();
    const rule = { urlPattern: '/api' };
    // Simulate fetch + XHR sharing the same rule object
    incrementCounter(rule, counters);
    incrementCounter(rule, counters);
    expect(counters.get(rule)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Combined: onNth with probability
// ---------------------------------------------------------------------------
describe('counting + probability interaction', () => {
  it('onNth with probability 1.0 fires exactly once on the Nth request', () => {
    const counters = new Map<object, number>();
    const rule = { onNth: 2 };
    const results: boolean[] = [];

    for (let i = 0; i < 5; i++) {
      const count = incrementCounter(rule, counters);
      const conditionMet = checkCountingCondition(rule, count);
      // With probability 1.0  -  always fires when condition is met
      results.push(conditionMet && true);
    }

    expect(results).toEqual([false, true, false, false, false]);
  });

  it('afterN with probability 1.0 fires for all requests past N', () => {
    const counters = new Map<object, number>();
    const rule = { afterN: 2 };
    const results: boolean[] = [];

    for (let i = 0; i < 5; i++) {
      const count = incrementCounter(rule, counters);
      results.push(checkCountingCondition(rule, count));
    }

    expect(results).toEqual([false, false, true, true, true]);
  });

  it('everyNth=3 fires on requests 3 and 6 of 7', () => {
    const counters = new Map<object, number>();
    const rule = { everyNth: 3 };
    const results: boolean[] = [];

    for (let i = 0; i < 7; i++) {
      const count = incrementCounter(rule, counters);
      results.push(checkCountingCondition(rule, count));
    }

    expect(results).toEqual([false, false, true, false, false, true, false]);
  });
});
