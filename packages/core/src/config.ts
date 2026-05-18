import type { RuleGroupConfig } from './groups';
import type { PresetConfigSlice } from './presets';
import type { ProfileConfigSlice, ProfileOverrideSlice } from './profiles';

/** Counting options shared by all network chaos config types.
 *  At most one of `onNth`, `everyNth`, or `afterN` may be set on a single rule.
 *  Counting is per-rule and shared across fetch + XHR (only increments when a
 *  request matches `urlPattern` + `methods`).
 *  - `onNth`    – apply chaos only on the Nth matching request (1-based). e.g. `onNth: 3` fires on the 3rd request only.
 *  - `everyNth` – apply chaos on every Nth matching request. e.g. `everyNth: 3` fires on the 3rd, 6th, 9th, …
 *  - `afterN`   – apply chaos only after the first N matching requests have passed through. e.g. `afterN: 3` fires from the 4th request onward.
 */
export interface RequestCountingOptions {
  onNth?: number;
  everyNth?: number;
  afterN?: number;
}

/** Optional group membership shared by every rule type.
 *  Rules without a `group` belong to the implicit `'default'` group, which is
 *  always enabled. Toggling a group at runtime via `enableGroup` /
 *  `disableGroup` skips its rules without restarting the engine — counters
 *  stay intact across toggles. */
export interface RuleGroupAssignment {
  group?: string;
}

/** Match a GraphQL operation by name. Applied AFTER `urlPattern` + `methods`
 *  as an additive filter — never a replacement. Matches against:
 *  - JSON `operationName` field on POST request bodies, OR
 *  - the operation name parsed from the `query` field (e.g. `query GetUser { … }`),
 *  - `?operationName=` query parameter for persisted-query GET requests, OR
 *  - operation name parsed from `?query=` in GET requests carrying GraphQL text.
 *
 *  When the rule has `graphqlOperation` set but the request body cannot be
 *  parsed (multipart upload, ReadableStream, binary), the rule is skipped and
 *  a diagnostic event is emitted with `applied: false, reason: 'graphql-body-unparseable'`.
 *  XHR requests with non-string bodies are treated the same way.
 *
 *  - `string` matches the operation name exactly.
 *  - `RegExp` matches when `.test(operationName)` returns true.
 */
export type GraphQLOperationMatcher = string | RegExp;

/** Common matcher fields shared by every network chaos rule type. */
export interface NetworkRuleMatchers {
  urlPattern: string;
  methods?: string[];
  graphqlOperation?: GraphQLOperationMatcher;
}

export interface NetworkFailureConfig extends RequestCountingOptions, NetworkRuleMatchers, RuleGroupAssignment {
  statusCode: number;
  probability: number;
  body?: string;
  statusText?: string;
  headers?: Record<string, string>;
}

export interface NetworkLatencyConfig extends RequestCountingOptions, NetworkRuleMatchers, RuleGroupAssignment {
  delayMs: number;
  probability: number;
}

export interface NetworkAbortConfig extends RequestCountingOptions, NetworkRuleMatchers, RuleGroupAssignment {
  probability: number;
  timeout?: number; // ms before abort; 0 or omitted = immediate
}

export type CorruptionStrategy = 'truncate' | 'malformed-json' | 'empty' | 'wrong-type';

export interface NetworkCorruptionConfig extends RequestCountingOptions, NetworkRuleMatchers, RuleGroupAssignment {
  probability: number;
  strategy: CorruptionStrategy;
}

export interface NetworkCorsConfig extends RequestCountingOptions, NetworkRuleMatchers, RuleGroupAssignment {
  probability: number;
}

export interface NetworkConfig {
  failures?: NetworkFailureConfig[];
  latencies?: NetworkLatencyConfig[];
  aborts?: NetworkAbortConfig[];
  corruptions?: NetworkCorruptionConfig[];
  cors?: NetworkCorsConfig[];
}

export interface UiAssaultConfig extends RuleGroupAssignment {
  selector: string;
  action: 'disable' | 'hide' | 'remove';
  probability: number;
}

export interface UiConfig {
  assaults?: UiAssaultConfig[];
}

/** Direction of a WebSocket message relative to the client.
 *  - `outbound` = client → server (intercepted at `.send()`).
 *  - `inbound`  = server → client (intercepted at `message` event dispatch).
 *  - `both`     = apply independently in either direction.
 */
export type WebSocketDirection = 'inbound' | 'outbound' | 'both';

export interface WebSocketDropConfig extends RequestCountingOptions, RuleGroupAssignment {
  urlPattern: string;
  direction: WebSocketDirection;
  probability: number;
}

export interface WebSocketDelayConfig extends RequestCountingOptions, RuleGroupAssignment {
  urlPattern: string;
  direction: WebSocketDirection;
  delayMs: number;
  probability: number;
}

/** Strategies for corrupting WebSocket payloads.
 *  `truncate` and `empty` apply to both text and binary payloads.
 *  `malformed-json` and `wrong-type` apply to text payloads only; when the
 *  actual payload at runtime is binary, corruption is skipped and an event is
 *  emitted with `applied: false`.
 */
export type WebSocketCorruptionStrategy = 'truncate' | 'malformed-json' | 'empty' | 'wrong-type';

export interface WebSocketCorruptConfig extends RequestCountingOptions, RuleGroupAssignment {
  urlPattern: string;
  direction: WebSocketDirection;
  strategy: WebSocketCorruptionStrategy;
  probability: number;
}

export interface WebSocketCloseConfig extends RequestCountingOptions, RuleGroupAssignment {
  urlPattern: string;
  /**
   * WebSocket close code. Must be either `1000` (Normal Closure) or in the
   * `3000–4999` range per the WebSocket spec; other values are rejected by
   * the browser's `close()` call. Defaults to `1000`. Use `4000–4999` for
   * application-defined chaos codes.
   */
  code?: number;
  /**
   * WebSocket close reason string. Must encode to <= 123 UTF-8 bytes per the
   * spec. Defaults to `"Chaos Maker close"`.
   */
  reason?: string;
  /** Delay after `open` before closing, in ms. Default 0 = close immediately. */
  afterMs?: number;
  probability: number;
}

export interface WebSocketConfig {
  drops?: WebSocketDropConfig[];
  delays?: WebSocketDelayConfig[];
  corruptions?: WebSocketCorruptConfig[];
  closes?: WebSocketCloseConfig[];
}

/** Strategies for corrupting Server-Sent Event payloads.
 *  All four strategies operate on `event.data` (always a string per the SSE
 *  spec). Mirrors the fetch / WebSocket corruption shape so the same
 *  vocabulary applies across protocols.
 */
export type SSECorruptionStrategy = 'truncate' | 'malformed-json' | 'empty' | 'wrong-type';

/** Filter SSE chaos to a specific event type.
 *  - `'message'` (default in the spec) targets unnamed events fired via
 *    `onmessage` / `addEventListener('message', …)`.
 *  - Any other string targets named events dispatched with `event:` lines.
 *  - `'*'` matches every event regardless of name.
 */
export type SSEEventTypeMatcher = string | '*';

export interface SSEDropConfig extends RequestCountingOptions, RuleGroupAssignment {
  urlPattern: string;
  eventType?: SSEEventTypeMatcher;
  probability: number;
}

export interface SSEDelayConfig extends RequestCountingOptions, RuleGroupAssignment {
  urlPattern: string;
  eventType?: SSEEventTypeMatcher;
  delayMs: number;
  probability: number;
}

export interface SSECorruptConfig extends RequestCountingOptions, RuleGroupAssignment {
  urlPattern: string;
  eventType?: SSEEventTypeMatcher;
  strategy: SSECorruptionStrategy;
  probability: number;
}

export interface SSECloseConfig extends RequestCountingOptions, RuleGroupAssignment {
  urlPattern: string;
  /** Delay after `open` before dispatching `error` + closing, in ms. Default 0. */
  afterMs?: number;
  probability: number;
}

export interface SSEConfig {
  drops?: SSEDropConfig[];
  delays?: SSEDelayConfig[];
  corruptions?: SSECorruptConfig[];
  closes?: SSECloseConfig[];
}

export interface ChaosConfig {
  network?: NetworkConfig;
  ui?: UiConfig;
  websocket?: WebSocketConfig;
  sse?: SSEConfig;
  /**
   * Pre-register rule groups with an explicit initial enabled state.
   *
   * Rules opt into a group by setting `group: 'name'`; groups referenced from
   * rules but not listed here are auto-registered as enabled. Use this field
   * only to ship a group as initially disabled (e.g. `{ name: 'payments',
   * enabled: false }`) or to reserve a group name with no rules attached yet.
   */
  groups?: RuleGroupConfig[];
  /**
   * Enable Chaos Maker's structured Debug Mode. When `true`, every
   * rule decision emits a `type: 'debug'` event (with `detail.stage`)
   * through the emitter AND mirrors a `[Chaos] <stage> ...` line to
   * `console.debug`. Framework-agnostic — does not touch
   * Playwright/Cypress/Puppeteer/WDIO debug semantics. Defaults to `false`;
   * fast-path no-op when off.
   *
   * Accepts `boolean` for the common case or `{ enabled: boolean }` to match
   * the `DebugOptions` shape that future Debug Mode extensions (`level`,
   * `prefix`, `console`, `sink`) will add. The validator coerces both forms;
   * the runtime normalizes them via `normalizeDebugOption()`.
   */
  debug?: boolean | { enabled: boolean };
  /**
   * Names of presets to expand into this config at engine init.
   * Resolved against the per-instance `PresetRegistry` seeded with built-ins
   * (camelCase names plus the four kebab-case aliases) and any
   * `customPresets` provided alongside this field.
   *
   * Merge semantics: append-only. Each preset's rule arrays concatenate onto
   * the user's rule arrays in the order listed here, preset rules first and
   * user rules last. Duplicate names are silently deduplicated, preserving
   * first occurrence. Unknown names throw `ChaosConfigError` at construction.
   *
   * Preset configs themselves cannot carry `presets` or `customPresets` —
   * dependency chains are out of scope and rejected by the schema.
   */
  presets?: string[];
  /**
   * Per-instance custom presets registered alongside the built-ins.
   * Each value is a `PresetConfigSlice` (a `ChaosConfig` minus `presets`,
   * `customPresets`, `seed`, and `debug`). Names collide fail-fast against
   * built-ins and against each other — pick a unique label.
   *
   * Custom preset literals stay mutable on input; the engine deep-clones them
   * during expansion, so post-construction tweaks are not observed by the
   * runtime.
   */
  customPresets?: Record<string, PresetConfigSlice>;
  /**
   * Name of a scenario profile to resolve against the per-instance
   * `ProfileRegistry` (seeded with the built-in `mobileCheckout` demo plus any
   * entries supplied via `customProfiles`).
   *
   * Singular by design — a profile IS the named scenario. Multi-profile
   * composition belongs inside the profile's own `presets: []` field. Unknown
   * profile names throw `ChaosConfigError` at construction with
   * `code: 'unknown_profile'`.
   *
   * Resolution order inside `prepareChaosConfig` is: Zod pass 1 -> profile
   * resolution -> preset expansion -> Zod pass 2. The post-resolution config
   * has `profile`, `profileOverrides`, and `customProfiles` stripped.
   */
  profile?: string;
  /**
   * Runtime override slice applied AFTER profile resolution. Use this to tune
   * a single parameter of a shared profile from a CI run or one test without
   * forking the profile definition.
   *
   * Precedence for the `seed` and `debug` scalars (highest wins):
   *   `profileOverrides` > top-level `seed`/`debug` > profile's own values.
   *
   * Rule arrays append (never replace) — overrides extend the merged rule
   * list rather than substituting it. Carries the same shape constraints as
   * a profile slice: no nested `profile`, `profileOverrides`, `customProfiles`,
   * `customPresets`, or `schemaVersion`.
   */
  profileOverrides?: ProfileOverrideSlice;
  /**
   * Per-instance custom scenario profiles registered alongside the built-in
   * demo. Each value is a `ProfileConfigSlice` (a `ChaosConfig` minus
   * `customPresets`, `customProfiles`, `profile`, `profileOverrides`, and
   * `schemaVersion`). Names collide fail-fast against the built-in entries
   * and against each other.
   *
   * Custom profile literals stay mutable on input; resolution deep-clones at
   * apply time so post-construction tweaks are not observed by the runtime.
   */
  customProfiles?: Record<string, ProfileConfigSlice>;
  /**
   * Reserved for forward-compatibility with future shape changes.
   * Defaults to `1`. Unknown values are rejected at validation time with
   * `code: 'unknown_schema_version'`. Omit this field unless a future major
   * release explicitly bumps the supported version.
   */
  schemaVersion?: 1;
  /**
   * Seed for Chaos Maker's PRNG.
   *
   * The seed controls every probability-driven chaos decision across network,
   * UI, and WebSocket rules. With the same seed and the same interaction
   * sequence, Chaos Maker emits the same `ChaosEvent` decision sequence after
   * normalizing runtime-only fields such as `timestamp`.
   *
   * When omitted, Chaos Maker auto-generates a seed from `Math.random()` during
   * instance creation. Read it with the adapter's `getChaosSeed()` helper and
   * log it on failure to replay the run.
   *
   * The seed does not control browser-native nondeterminism, wall-clock
   * timestamps, network/server timing, or task-scheduler ordering in the app
   * under test.
   */
  seed?: number;
}
