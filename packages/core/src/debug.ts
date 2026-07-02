/**
 * Debug Mode.
 *
 * Two-sink logger that fires when `ChaosConfig.debug` is `true`:
 *   1. Structured `type: 'debug'` events through `ChaosEventEmitter`  - 
 *      consumers subscribe via `instance.on('debug', cb)` and switch on
 *      `event.detail.stage` for the stage taxonomy.
 *   2. A formatted `[Chaos] <stage> ...` line (or `[Chaos SW] <stage> ...`
 *      when the logger targets a Service Worker) to `console.debug`. Hidden
 *      by default in CI loggers, visible in browser DevTools.
 *
 * Framework-agnostic: never reads `process.env.DEBUG`, `--debug`, or
 * `localStorage.debug`. The only signal is `ChaosConfig.debug`.
 */

import type { ChaosConfig } from './config';
import type { ChaosDebugStage, ChaosEvent } from './events';
import { ruleMatcherOrigin } from './matchers';

export type { ChaosDebugStage } from './events';

export interface DebugOptions {
  enabled: boolean;
}

export function normalizeDebugOption(input: boolean | DebugOptions | undefined): DebugOptions {
  if (input === undefined) return { enabled: false };
  if (typeof input === 'boolean') return { enabled: input };
  return { enabled: input.enabled };
}

/** Identity assigned to every rule object in a config snapshot. */
export interface RuleIdEntry {
  ruleType: string;
  ruleId: string;
  /** Name of the registered `NamedMatcher` that produced this rule's matcher
   *  fields via `resolveNamedMatchers`. Present only when the rule was
   *  matcher-resolved; the `ChaosEventEmitter.debug()` path uses this to
   *  enrich every debug event with `detail.matcherName`. */
  matcherName?: string;
}

const RULE_TYPE_BY_ARRAY: ReadonlyArray<{
  pick: (cfg: ChaosConfig) => readonly object[] | undefined;
  ruleType: string;
}> = [
  { pick: (c) => c.network?.failures, ruleType: 'failure' },
  { pick: (c) => c.network?.latencies, ruleType: 'latency' },
  { pick: (c) => c.network?.aborts, ruleType: 'abort' },
  { pick: (c) => c.network?.corruptions, ruleType: 'corruption' },
  { pick: (c) => c.network?.cors, ruleType: 'cors' },
  { pick: (c) => c.ui?.assaults, ruleType: 'ui-assault' },
  { pick: (c) => c.websocket?.drops, ruleType: 'ws-drop' },
  { pick: (c) => c.websocket?.delays, ruleType: 'ws-delay' },
  { pick: (c) => c.websocket?.corruptions, ruleType: 'ws-corrupt' },
  { pick: (c) => c.websocket?.closes, ruleType: 'ws-close' },
  { pick: (c) => c.sse?.drops, ruleType: 'sse-drop' },
  { pick: (c) => c.sse?.delays, ruleType: 'sse-delay' },
  { pick: (c) => c.sse?.corruptions, ruleType: 'sse-corrupt' },
  { pick: (c) => c.sse?.closes, ruleType: 'sse-close' },
  { pick: (c) => c.fetchStream?.drops, ruleType: 'fetch-stream-drop' },
  { pick: (c) => c.fetchStream?.delays, ruleType: 'fetch-stream-delay' },
  { pick: (c) => c.fetchStream?.corruptions, ruleType: 'fetch-stream-corrupt' },
  { pick: (c) => c.fetchStream?.closes, ruleType: 'fetch-stream-close' },
];

/**
 * Build a positional rule-id map for a config snapshot. IDs are
 * `<ruleType>#<index>` derived from the order rules appear in their array.
 * Reordering rules between runs changes the IDs  -  acceptable for in-test
 * diagnostics.
 */
export function buildRuleIdMap(config: ChaosConfig): WeakMap<object, RuleIdEntry> {
  const map = new WeakMap<object, RuleIdEntry>();
  for (const { pick, ruleType } of RULE_TYPE_BY_ARRAY) {
    const arr = pick(config);
    if (!arr) continue;
    arr.forEach((rule, index) => {
      const entry: RuleIdEntry = { ruleType, ruleId: `${ruleType}#${index}` };
      // Serializable stamp first (survives the page boundary), WeakMap
      // fallback for node-side rule objects that never crossed one.
      const stamped = (rule as { matcherName?: unknown }).matcherName;
      const matcherName =
        typeof stamped === 'string' && stamped.length > 0
          ? stamped
          : ruleMatcherOrigin.get(rule as object);
      if (matcherName !== undefined) entry.matcherName = matcherName;
      map.set(rule as object, entry);
    });
  }
  return map;
}

/**
 * Build the human-readable body mirrored to `console.debug`. Does NOT include
 * the `[Chaos]` / `[Chaos SW]` prefix  -  that is owned by `Logger.log()` and
 * varies by target so the two never compose into a doubled prefix.
 */
export function formatDebugMessage(stage: ChaosDebugStage, detail: ChaosEvent['detail']): string {
  const parts: string[] = [];
  if (detail.ruleId) parts.push(`rule=${detail.ruleId}`);
  if (detail.matcherName) parts.push(`matcher=${detail.matcherName}`);
  if (detail.phase) parts.push(detail.phase);
  if (detail.method) parts.push(detail.method);
  if (detail.url) parts.push(detail.url);
  if (detail.statusCode !== undefined) parts.push(`-> ${detail.statusCode}`);
  if (detail.delayMs !== undefined) parts.push(`+${detail.delayMs}ms`);
  if (detail.direction) parts.push(detail.direction);
  if (detail.eventType) parts.push(`event=${detail.eventType}`);
  if (detail.selector) parts.push(`selector=${detail.selector}`);
  if (detail.action) parts.push(`action=${detail.action}`);
  if (detail.strategy) parts.push(`strategy=${detail.strategy}`);
  if (detail.groupName) parts.push(`group=${detail.groupName}`);
  if (detail.reason) parts.push(`reason=${detail.reason}`);
  if (detail.matchedBy && detail.matchedBy.length > 0) parts.push(`matched=${detail.matchedBy.join(',')}`);
  if (detail.skippedAt) parts.push(`skippedAt=${detail.skippedAt}`);
  return parts.length === 0 ? stage : `${stage}: ${parts.join(' ')}`;
}

export class Logger {
  constructor(private readonly opts: DebugOptions, private readonly target: 'page' | 'sw' = 'page') {}

  isEnabled(): boolean {
    return this.opts.enabled;
  }

  /**
   * Build a `type: 'debug'` event with `detail.stage = stage`, mirror a
   * `[Chaos] ...` (page) or `[Chaos SW] ...` (Service Worker) line to
   * `console.debug`, and return the event for the emitter to fan out. The
   * formatted string is never stored on the event payload.
   *
   * Returns `null` when the logger was constructed with `enabled: false`.
   * Internal callers (the emitter fast-path) never reach this branch because
   * `ChaosMaker` does not attach a logger when debug is off, but the guard
   * keeps the public `Logger` API consistent with the `DebugOptions.enabled`
   * contract for external consumers who instantiate it directly.
   */
  log(stage: ChaosDebugStage, detail: ChaosEvent['detail']): ChaosEvent | null {
    if (!this.opts.enabled) return null;
    const finalDetail: ChaosEvent['detail'] = { ...detail, stage };
    const event: ChaosEvent = {
      type: 'debug',
      timestamp: Date.now(),
      applied: false,
      detail: finalDetail,
    };
    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      const prefix = this.target === 'sw' ? '[Chaos SW]' : '[Chaos]';
      // Isolate the console sink from the structured-event path: a host that
      // monkey-patched `console.debug` to throw must not abort `Logger.log()`
      // and starve the emitter of its event. Swallowed errors stay local to
      // the sink.
      try {
        console.debug(`${prefix} ${formatDebugMessage(stage, finalDetail)}`);
      } catch {
        /* console sink unavailable or throwing  -  observability best-effort */
      }
    }
    return event;
  }
}
