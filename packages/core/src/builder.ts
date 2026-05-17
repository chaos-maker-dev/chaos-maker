import { ChaosConfig, CorruptionStrategy, GraphQLOperationMatcher, RequestCountingOptions, SSECorruptionStrategy, WebSocketDirection, WebSocketCorruptionStrategy } from './config';
import type { RuleGroupConfig } from './groups';
import type { ProfileConfigSlice, ProfileOverrideSlice } from './profiles';
import { cloneValue } from './utils';

function cloneConfig(config: ChaosConfig): ChaosConfig {
  return cloneValue(config);
}

function normalizeGroupName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('[chaos-maker] Group name cannot be empty');
  }
  return trimmed;
}

function normalizePresetNameForBuilder(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('[chaos-maker] preset name cannot be empty');
  }
  return trimmed;
}

function normalizeProfileNameForBuilder(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('[chaos-maker] profile name cannot be empty');
  }
  return trimmed;
}

/** Append-merge a profile slice into a target accumulator. Rule-bearing
 *  categories concatenate (matching `applyProfile`'s append semantics); the
 *  `presets[]`, `seed`, `debug`, and `groups` fields layer with the slice's
 *  values winning over what the accumulator already holds, so a later
 *  `.overrideProfile(...)` call always wins over an earlier one (matching
 *  the "last-write-wins" scalar precedence at resolution time). */
function mergeProfileSliceInPlace(target: ProfileOverrideSlice, slice: ProfileOverrideSlice): void {
  for (const cat of ['network', 'ui', 'websocket', 'sse'] as const) {
    const src = slice[cat] as Record<string, unknown> | undefined;
    if (!src) continue;
    const dst = ((target[cat] ??= {}) as unknown) as Record<string, unknown>;
    for (const [k, arr] of Object.entries(src)) {
      if (!Array.isArray(arr)) {
        // Preserve malformed (non-array) value so downstream Zod validation
        // surfaces a useful error path instead of a silent drop here.
        dst[k] = arr;
        continue;
      }
      ((dst[k] ??= []) as unknown[]).push(...arr);
    }
  }
  if (slice.groups?.length) {
    (target.groups ??= []).push(...slice.groups);
  }
  if (slice.presets) {
    target.presets = [...(target.presets ?? []), ...slice.presets];
  }
  if (slice.seed !== undefined) target.seed = slice.seed;
  if (slice.debug !== undefined) target.debug = slice.debug;
}

export class ChaosConfigBuilder {
  private config: ChaosConfig;
  /** Single-shot group name applied to the next rule pushed and then cleared.
   *  Sticky semantics intentionally rejected — silent capture of stale groups
   *  is harder to debug than the explicit re-chain. */
  private pendingGroup?: string;
  /** Queued preset names for `.usePreset(...)`. Silently deduped on
   *  push. Flushed onto `out.presets` in `.build()` when non-empty. */
  private pendingPresets: string[] = [];

  constructor(initialConfig?: ChaosConfig) {
    this.config = initialConfig ? cloneConfig(initialConfig) : { network: {}, ui: {}, websocket: {}, sse: {} };
    if (!this.config.network) this.config.network = {};
    if (!this.config.ui) this.config.ui = {};
    if (!this.config.websocket) this.config.websocket = {};
    if (!this.config.sse) this.config.sse = {};
  }

  /** Tag the next rule pushed with this group name.
   *  Single-shot: cleared after the next builder method that pushes a rule. */
  inGroup(name: string): this {
    this.pendingGroup = normalizeGroupName(name);
    return this;
  }

  /** Pre-register a group on the config (typically used to ship one as
   *  initially disabled). Equivalent to setting `ChaosConfig.groups` directly. */
  defineGroup(name: string, opts?: { enabled?: boolean }): this {
    if (!this.config.groups) this.config.groups = [];
    const entry: RuleGroupConfig = { name: normalizeGroupName(name) };
    if (opts?.enabled !== undefined) entry.enabled = opts.enabled;
    this.config.groups.push(entry);
    return this;
  }

  /** Apply `pendingGroup` (single-shot) to a rule literal before it is pushed.
   *  MUST be called at every rule-push site so `.inGroup(...)` is honored. */
  private withGroup<T extends object>(rule: T): T & { group?: string } {
    const g = this.pendingGroup;
    this.pendingGroup = undefined;
    return g ? { ...rule, group: g } : rule;
  }

  failRequests(urlPattern: string, statusCode: number, probability: number, methods?: string[], body?: string, headers?: Record<string, string>, counting?: RequestCountingOptions) {
    if (!this.config.network!.failures) this.config.network!.failures = [];
    this.config.network!.failures.push(this.withGroup({ urlPattern, statusCode, probability, methods, body, headers, ...counting }));
    return this;
  }

  addLatency(urlPattern: string, delayMs: number, probability: number, methods?: string[], counting?: RequestCountingOptions) {
    if (!this.config.network!.latencies) this.config.network!.latencies = [];
    this.config.network!.latencies.push(this.withGroup({ urlPattern, delayMs, probability, methods, ...counting }));
    return this;
  }

  abortRequests(urlPattern: string, probability: number, timeout?: number, methods?: string[], counting?: RequestCountingOptions) {
    if (!this.config.network!.aborts) this.config.network!.aborts = [];
    this.config.network!.aborts.push(this.withGroup({ urlPattern, probability, timeout, methods, ...counting }));
    return this;
  }

  corruptResponses(urlPattern: string, strategy: CorruptionStrategy, probability: number, methods?: string[], counting?: RequestCountingOptions) {
    if (!this.config.network!.corruptions) this.config.network!.corruptions = [];
    this.config.network!.corruptions.push(this.withGroup({ urlPattern, strategy, probability, methods, ...counting }));
    return this;
  }

  simulateCors(urlPattern: string, probability: number, methods?: string[], counting?: RequestCountingOptions) {
    if (!this.config.network!.cors) this.config.network!.cors = [];
    this.config.network!.cors.push(this.withGroup({ urlPattern, probability, methods, ...counting }));
    return this;
  }

  // --- onNth shortcuts ---

  failRequestsOnNth(urlPattern: string, statusCode: number, n: number, methods?: string[]) {
    return this.failRequests(urlPattern, statusCode, 1, methods, undefined, undefined, { onNth: n });
  }

  addLatencyOnNth(urlPattern: string, delayMs: number, n: number, methods?: string[]) {
    return this.addLatency(urlPattern, delayMs, 1, methods, { onNth: n });
  }

  abortRequestsOnNth(urlPattern: string, n: number, timeout?: number, methods?: string[]) {
    return this.abortRequests(urlPattern, 1, timeout, methods, { onNth: n });
  }

  corruptResponsesOnNth(urlPattern: string, strategy: CorruptionStrategy, n: number, methods?: string[]) {
    return this.corruptResponses(urlPattern, strategy, 1, methods, { onNth: n });
  }

  simulateCorsOnNth(urlPattern: string, n: number, methods?: string[]) {
    return this.simulateCors(urlPattern, 1, methods, { onNth: n });
  }

  // --- everyNth shortcuts ---

  failRequestsEveryNth(urlPattern: string, statusCode: number, n: number, methods?: string[]) {
    return this.failRequests(urlPattern, statusCode, 1, methods, undefined, undefined, { everyNth: n });
  }

  addLatencyEveryNth(urlPattern: string, delayMs: number, n: number, methods?: string[]) {
    return this.addLatency(urlPattern, delayMs, 1, methods, { everyNth: n });
  }

  abortRequestsEveryNth(urlPattern: string, n: number, timeout?: number, methods?: string[]) {
    return this.abortRequests(urlPattern, 1, timeout, methods, { everyNth: n });
  }

  corruptResponsesEveryNth(urlPattern: string, strategy: CorruptionStrategy, n: number, methods?: string[]) {
    return this.corruptResponses(urlPattern, strategy, 1, methods, { everyNth: n });
  }

  simulateCorsEveryNth(urlPattern: string, n: number, methods?: string[]) {
    return this.simulateCors(urlPattern, 1, methods, { everyNth: n });
  }

  // --- afterN shortcuts ---

  failRequestsAfterN(urlPattern: string, statusCode: number, n: number, methods?: string[]) {
    return this.failRequests(urlPattern, statusCode, 1, methods, undefined, undefined, { afterN: n });
  }

  addLatencyAfterN(urlPattern: string, delayMs: number, n: number, methods?: string[]) {
    return this.addLatency(urlPattern, delayMs, 1, methods, { afterN: n });
  }

  abortRequestsAfterN(urlPattern: string, n: number, timeout?: number, methods?: string[]) {
    return this.abortRequests(urlPattern, 1, timeout, methods, { afterN: n });
  }

  corruptResponsesAfterN(urlPattern: string, strategy: CorruptionStrategy, n: number, methods?: string[]) {
    return this.corruptResponses(urlPattern, strategy, 1, methods, { afterN: n });
  }

  simulateCorsAfterN(urlPattern: string, n: number, methods?: string[]) {
    return this.simulateCors(urlPattern, 1, methods, { afterN: n });
  }

  assaultUi(selector: string, action: 'disable' | 'hide' | 'remove', probability: number) {
    if (!this.config.ui!.assaults) this.config.ui!.assaults = [];
    this.config.ui!.assaults.push(this.withGroup({ selector, action, probability }));
    return this;
  }

  // --- WebSocket chaos ---

  dropMessages(urlPattern: string, direction: WebSocketDirection, probability: number, counting?: RequestCountingOptions) {
    if (!this.config.websocket!.drops) this.config.websocket!.drops = [];
    this.config.websocket!.drops.push(this.withGroup({ urlPattern, direction, probability, ...counting }));
    return this;
  }

  delayMessages(urlPattern: string, direction: WebSocketDirection, delayMs: number, probability: number, counting?: RequestCountingOptions) {
    if (!this.config.websocket!.delays) this.config.websocket!.delays = [];
    this.config.websocket!.delays.push(this.withGroup({ urlPattern, direction, delayMs, probability, ...counting }));
    return this;
  }

  corruptMessages(urlPattern: string, direction: WebSocketDirection, strategy: WebSocketCorruptionStrategy, probability: number, counting?: RequestCountingOptions) {
    if (!this.config.websocket!.corruptions) this.config.websocket!.corruptions = [];
    this.config.websocket!.corruptions.push(this.withGroup({ urlPattern, direction, strategy, probability, ...counting }));
    return this;
  }

  closeConnection(urlPattern: string, probability: number, opts?: { code?: number; reason?: string; afterMs?: number }, counting?: RequestCountingOptions) {
    if (!this.config.websocket!.closes) this.config.websocket!.closes = [];
    this.config.websocket!.closes.push(this.withGroup({ urlPattern, probability, ...opts, ...counting }));
    return this;
  }

  // Counting shortcuts (only the two highest-value ones — see plan §8).

  dropMessagesOnNth(urlPattern: string, direction: WebSocketDirection, n: number) {
    return this.dropMessages(urlPattern, direction, 1, { onNth: n });
  }

  delayMessagesOnNth(urlPattern: string, direction: WebSocketDirection, delayMs: number, n: number) {
    return this.delayMessages(urlPattern, direction, delayMs, 1, { onNth: n });
  }

  // --- GraphQL operation shortcuts ---

  /** Fail every GraphQL request matching `operationName`.
   *  Defaults `urlPattern` to `'*'`; pass an explicit pattern as the 4th
   *  argument to scope to a specific endpoint. */
  failGraphQLOperation(operationName: GraphQLOperationMatcher, statusCode: number, probability: number, urlPattern: string = '*') {
    if (!this.config.network!.failures) this.config.network!.failures = [];
    this.config.network!.failures.push(this.withGroup({ urlPattern, statusCode, probability, graphqlOperation: operationName }));
    return this;
  }

  /** Add `delayMs` of latency to every GraphQL request matching `operationName`. */
  delayGraphQLOperation(operationName: GraphQLOperationMatcher, delayMs: number, probability: number, urlPattern: string = '*') {
    if (!this.config.network!.latencies) this.config.network!.latencies = [];
    this.config.network!.latencies.push(this.withGroup({ urlPattern, delayMs, probability, graphqlOperation: operationName }));
    return this;
  }

  // --- SSE / EventSource chaos ---

  dropSSE(urlPattern: string, probability: number, eventType?: string, counting?: RequestCountingOptions) {
    if (!this.config.sse!.drops) this.config.sse!.drops = [];
    this.config.sse!.drops.push(this.withGroup({ urlPattern, probability, ...(eventType ? { eventType } : {}), ...counting }));
    return this;
  }

  delaySSE(urlPattern: string, delayMs: number, probability: number, eventType?: string, counting?: RequestCountingOptions) {
    if (!this.config.sse!.delays) this.config.sse!.delays = [];
    this.config.sse!.delays.push(this.withGroup({ urlPattern, delayMs, probability, ...(eventType ? { eventType } : {}), ...counting }));
    return this;
  }

  corruptSSE(urlPattern: string, strategy: SSECorruptionStrategy, probability: number, eventType?: string, counting?: RequestCountingOptions) {
    if (!this.config.sse!.corruptions) this.config.sse!.corruptions = [];
    this.config.sse!.corruptions.push(this.withGroup({ urlPattern, strategy, probability, ...(eventType ? { eventType } : {}), ...counting }));
    return this;
  }

  closeSSE(urlPattern: string, probability: number, opts?: { afterMs?: number }, counting?: RequestCountingOptions) {
    if (!this.config.sse!.closes) this.config.sse!.closes = [];
    this.config.sse!.closes.push(this.withGroup({ urlPattern, probability, ...opts, ...counting }));
    return this;
  }

  /** Set the PRNG seed for reproducible chaos. */
  withSeed(seed: number) {
    this.config.seed = seed;
    return this;
  }

  /** Toggle Debug Mode on this config. Off by default. */
  withDebug(enabled: boolean = true) {
    this.config.debug = enabled;
    return this;
  }

  /** Queue a preset name to be expanded at engine init.
   *  Silently dedups within the builder, preserving insertion order. Empty
   *  / whitespace-only names throw, matching the schema and registry rules. */
  usePreset(name: string): this {
    const norm = normalizePresetNameForBuilder(name);
    if (!this.pendingPresets.includes(norm)) this.pendingPresets.push(norm);
    return this;
  }

  /** Set the scenario profile to resolve at engine init.
   *  Singular by design — calling again replaces the previously set profile.
   *  Empty / whitespace-only names throw. The profile is resolved by the
   *  per-instance `ProfileRegistry` during `prepareChaosConfig`. */
  useProfile(name: string): this {
    this.config.profile = normalizeProfileNameForBuilder(name);
    return this;
  }

  /** Register an inline scenario profile alongside the built-in demo entry.
   *  Equivalent to setting one key on `ChaosConfig.customProfiles`. Names
   *  collide fail-fast against the built-in `mobileCheckout` entry and
   *  against each other at engine init. */
  defineProfile(name: string, slice: ProfileConfigSlice): this {
    const norm = normalizeProfileNameForBuilder(name);
    if (!this.config.customProfiles) this.config.customProfiles = {};
    if (Object.prototype.hasOwnProperty.call(this.config.customProfiles, norm)) {
      throw new Error(`[chaos-maker] profile '${norm}' already defined on this builder`);
    }
    this.config.customProfiles[norm] = cloneValue(slice);
    return this;
  }

  /** Accumulate a runtime override slice. Rule arrays append across calls; the
   *  `seed`, `debug`, `groups`, and `presets[]` fields layer with the later
   *  call winning (matching the "last-write-wins" scalar precedence applied at
   *  resolution time). Multiple `.overrideProfile(...)` calls compose. */
  overrideProfile(slice: ProfileOverrideSlice): this {
    if (!this.config.profileOverrides) this.config.profileOverrides = {};
    mergeProfileSliceInPlace(this.config.profileOverrides, cloneValue(slice));
    return this;
  }

  build(): ChaosConfig {
    const out = cloneConfig(this.config);
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const name of [...(out.presets ?? []), ...this.pendingPresets]) {
      if (!seen.has(name)) {
        seen.add(name);
        merged.push(name);
      }
    }
    if (merged.length) {
      out.presets = merged;
    } else {
      delete out.presets;
    }
    return out;
  }
}
