import type { ChaosEvent } from '@chaos-maker/core';
import type { ParityAssert } from './types';

/** Count chaos events of `type` that were actually applied. */
export function appliedCount(log: ChaosEvent[], type: ChaosEvent['type']): number {
  return log.filter((e) => e.type === type && e.applied).length;
}

/** True when at least one applied event of `type` is present. */
export function hasApplied(log: ChaosEvent[], type: ChaosEvent['type']): boolean {
  return appliedCount(log, type) > 0;
}

/** True when a `rule-matched` debug event reports `field` in its `matchedBy`
 *  attribution list. */
export function hasDebugMatchedBy(log: ChaosEvent[], field: string): boolean {
  return log.some(
    (e) =>
      e.type === 'debug' &&
      e.detail.stage === 'rule-matched' &&
      Array.isArray(e.detail.matchedBy) &&
      e.detail.matchedBy.includes(field),
  );
}

/** Throw-on-failure assertion shim shared by every adapter. Plain `Error`
 *  throws are recognized as test failures by Playwright, Cypress, Mocha
 *  (WebdriverIO), and Vitest (Puppeteer) alike, so every parity scenario
 *  passes or fails by identical logic regardless of the host test runner. */
export const strictAssert: ParityAssert = {
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(
        message ?? `expected ${String(expected)}, received ${String(actual)}`,
      );
    }
  },
  notEqual(actual, expected, message) {
    if (actual === expected) {
      throw new Error(message ?? `expected a value other than ${String(expected)}`);
    }
  },
  ok(value, message) {
    if (!value) {
      throw new Error(message ?? 'expected a truthy value');
    }
  },
};
