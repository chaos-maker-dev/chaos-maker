import type { ChaosConfig, CorruptionStrategy, RequestCountingOptions } from './config';
import { DEFAULT_GROUP_NAME, RuleGroupRegistry } from './groups';
import type { ChaosEvent, ChaosEventEmitter } from './events';

/** Recursive deep clone that preserves `RegExp` instances literally.
 *  `JSON.parse(JSON.stringify(...))` would silently drop `RegExp`, breaking
 *  matchers like `graphqlOperation: /^Get/`. Shared by builder + presets so a
 *  single implementation owns RegExp survival. */
export function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = cloneValue(val);
  }
  return out as T;
}

export function shouldApplyChaos(probability: number, random: () => number): boolean {
  return random() < probability;
}

/**
 * Increment the per-rule request counter and return the new count.
 * Keyed by the rule object reference so the same counter is shared across
 * fetch and XHR interceptors for a given config entry.
 */
export function incrementCounter(rule: object, counters: Map<object, number>): number {
  const next = (counters.get(rule) ?? 0) + 1;
  counters.set(rule, next);
  return next;
}

/**
 * Given a rule with optional counting fields and the current (already-incremented)
 * request count for that rule, return whether the chaos should fire this request.
 * Returns `true` when no counting field is set (counting is always opt-in).
 */
export function checkCountingCondition(rule: RequestCountingOptions, count: number): boolean {
  if (rule.onNth !== undefined) return count === rule.onNth;
  if (rule.everyNth !== undefined) return count % rule.everyNth === 0;
  if (rule.afterN !== undefined) return count > rule.afterN;
  if (rule.firstN !== undefined) return count <= rule.firstN;
  return true;
}

export function matchUrl(url: string, pattern: string | undefined): boolean {
  if (pattern === undefined || pattern === '*') return true;
  return url.includes(pattern);
}

export function corruptText(text: string, strategy: CorruptionStrategy): string {
  switch (strategy) {
    case 'truncate':
      return text.slice(0, Math.max(0, Math.floor(text.length / 2)));
    case 'malformed-json':
      return `${text}"}`;
    case 'empty':
      return '';
    case 'wrong-type':
      return '<html><body>Unexpected HTML</body></html>';
  }
}

/**
 * Group-active gate. Sits between `gateRule` and `shouldApplyChaos`
 * inside every interceptor.
 *
 * - `registry === undefined` (legacy / direct interceptor caller): returns
 *   `true` so the interceptor proceeds without group checks.
 * - When the rule's group is enabled: returns `true`.
 * - When disabled: emits at most one `rule-group:gated` event per group per
 *   toggle cycle (deduped via `RuleGroupRegistry.shouldEmitGated`) and
 *   returns `false`. The emitted detail merges `baseDetail` (e.g. url +
 *   method) with `groupName`.
 *
 * Counting (`onNth` / `everyNth` / `afterN`) runs *before* this gate inside
 * `gateRule`, so toggling a group does not desync per-rule counters.
 */
export function gateGroup(
  rule: { group?: string },
  registry: RuleGroupRegistry | undefined,
  emitter: ChaosEventEmitter | undefined,
  baseDetail: ChaosEvent['detail'],
): boolean {
  if (!registry) return true;
  if (registry.isActive(rule.group)) return true;
  const groupName = rule.group ?? DEFAULT_GROUP_NAME;
  if (registry.shouldEmitGated(groupName) && emitter) {
    emitter.emit({
      type: 'rule-group:gated',
      timestamp: Date.now(),
      applied: false,
      detail: { ...baseDetail, groupName },
    });
  }
  // debug event  -  independent of the dedup gate above so debug logs
  // surface every gated request (one per rule per call), not one per cycle.
  emitter?.debug('rule-skip-group', { ...baseDetail, groupName }, rule);
  return false;
}

/** Minimal rule shape walked by `forEachRule`. Carries the optional `group`
 *  field every rule type now supports plus an open index for the
 *  remaining per-rule fields the walker doesn't care about. */
export type AnyRule = { group?: string;[k: string]: unknown };

/**
 * Iterate every rule across every chaos category in the config exactly once.
 *
 * IMPORTANT: any new rule array added to `ChaosConfig` (e.g. `websocket.timeouts`,
 * `sse.reconnects`) MUST be registered here. The matching test in
 * `forEachRule.test.ts` asserts the visited count against a sample config; that
 * test will fail loudly if a new array is added without updating this walker.
 *
 * Single source of truth for rule iteration. Used by `seedGroupsFromRules`
 * and `collectReferencedGroups` in `ChaosMaker`, plus any future feature
 * that needs to walk all rules.
 */
export function forEachRule(config: ChaosConfig, fn: (rule: AnyRule) => void): void {
  const visit = (rules: AnyRule[] | undefined): void => {
    if (!rules) return;
    for (const r of rules) fn(r);
  };
  visit(config.network?.failures as AnyRule[] | undefined);
  visit(config.network?.latencies as AnyRule[] | undefined);
  visit(config.network?.aborts as AnyRule[] | undefined);
  visit(config.network?.corruptions as AnyRule[] | undefined);
  visit(config.network?.cors as AnyRule[] | undefined);
  visit(config.ui?.assaults as AnyRule[] | undefined);
  visit(config.websocket?.drops as AnyRule[] | undefined);
  visit(config.websocket?.delays as AnyRule[] | undefined);
  visit(config.websocket?.corruptions as AnyRule[] | undefined);
  visit(config.websocket?.closes as AnyRule[] | undefined);
  visit(config.sse?.drops as AnyRule[] | undefined);
  visit(config.sse?.delays as AnyRule[] | undefined);
  visit(config.sse?.corruptions as AnyRule[] | undefined);
  visit(config.sse?.closes as AnyRule[] | undefined);
  visit(config.fetchStream?.drops as AnyRule[] | undefined);
  visit(config.fetchStream?.delays as AnyRule[] | undefined);
  visit(config.fetchStream?.corruptions as AnyRule[] | undefined);
  visit(config.fetchStream?.closes as AnyRule[] | undefined);
}
