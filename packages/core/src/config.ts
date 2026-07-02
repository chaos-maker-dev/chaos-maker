import type { ChaosPhase } from './events';
import type { RuleGroupConfig } from './groups';
import type { PresetConfigSlice } from './presets';
import type { ProfileConfigSlice, ProfileOverrideSlice } from './profiles';

/** Counting options shared by all network chaos config types.
 *  At most one of `onNth`, `everyNth`, `afterN`, or `firstN` may be set on a
 *  single rule. Counting is per-rule and shared across fetch + XHR (only
 *  increments when a request matches `urlPattern` + `methods`).
 *  - `onNth`    – apply chaos only on the Nth matching request (1-based). e.g. `onNth: 3` fires on the 3rd request only.
 *  - `everyNth` – apply chaos on every Nth matching request. e.g. `everyNth: 3` fires on the 3rd, 6th, 9th, …
 *  - `afterN`   – apply chaos only after the first N matching requests have passed through. e.g. `afterN: 3` fires from the 4th request onward.
 *  - `firstN`   – apply chaos on the first N matching requests only. e.g. `firstN: 2` fires on the 1st and 2nd requests, then never again. Complements `afterN`; use for rate-limit style failures that clear after retries.
 */
export interface RequestCountingOptions {
  onNth?: number;
  everyNth?: number;
  afterN?: number;
  firstN?: number;
}

/** Optional group membership shared by every rule type.
 *  Rules without a `group` belong to the implicit `'default'` group, which is
 *  always enabled. Toggling a group at runtime via `enableGroup` /
 *  `disableGroup` skips its rules without restarting the engine  -  counters
 *  stay intact across toggles. */
export interface RuleGroupAssignment {
  group?: string;
}

/** Match a GraphQL operation by name. Applied AFTER `urlPattern` + `methods`
 *  as an additive filter  -  never a replacement. Matches against:
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

/** Match against the hostname portion of a request URL.
 *  - `string`  -  case-insensitive exact match against `new URL(url).hostname`.
 *  - `RegExp`  -  `.test(hostname)`; `g`/`y` flags rejected at validation time.
 */
export type HostnameMatcher = string | RegExp;

/** Per-key matcher for query parameters and request headers.
 *  - `true`  -  key must be present (value ignored).
 *  - `false`  -  key must be absent.
 *  - `string`  -  exact value match (decoded for query params; raw for headers).
 *  - `RegExp`  -  `.test(value)`; `g`/`y` flags rejected at validation time.
 */
export type RequestKvMatcher = string | RegExp | boolean;

/** Resource type bucket for network rules. Distinguishes between the two
 *  network interceptors (`fetch` vs `xhr`). WebSocket and SSE live in their
 *  own rule categories and are NOT addressable here. */
export type RequestResourceType = 'fetch' | 'xhr';

/** Reusable named matcher carried in `ChaosConfig.matchers`. A rule references
 *  one via `matcher: 'name'` instead of inlining matcher fields. Composition
 *  (a matcher referencing another matcher) is out of scope for this release.
 *
 *  Request header matchers live under `requestHeaders` (not `headers`) so the
 *  name does not collide with the response-synthesis `headers` field on
 *  `NetworkFailureConfig`. */
export interface NamedMatcher {
  urlPattern?: string;
  methods?: string[];
  graphqlOperation?: GraphQLOperationMatcher;
  hostname?: HostnameMatcher;
  queryParams?: Record<string, RequestKvMatcher>;
  requestHeaders?: Record<string, RequestKvMatcher>;
  resourceTypes?: RequestResourceType[];
}

/** Common matcher fields shared by every network chaos rule type.
 *
 *  A rule MUST use EITHER `matcher: 'name'` (referencing a registered
 *  `NamedMatcher`) OR at least one inline matcher field. Mixing the two
 *  surfaces a `matcher_inline_conflict` validation error.
 *
 *  Inline matcher semantics:
 *  - `urlPattern`  -  substring match (or `'*'` for any URL).
 *  - `methods`  -  HTTP method whitelist (case-sensitive after `.toUpperCase()`
 *    at the interceptor).
 *  - `hostname`  -  case-insensitive exact match or RegExp test against the
 *    request URL's hostname.
 *  - `queryParams`  -  per-key matcher map; every entry must pass.
 *  - `requestHeaders`  -  per-key matcher map for REQUEST headers (key
 *    comparison is case-insensitive); every entry must pass. The name is
 *    `requestHeaders` (not `headers`) so it does not collide with the
 *    response-synthesis `headers` field on `NetworkFailureConfig`.
 *  - `resourceTypes`  -  non-empty subset of `{'fetch','xhr'}`; rule fires only
 *    when the originating interceptor is in the list.
 *  - `graphqlOperation`  -  applied AFTER all other matchers.
 */
export interface NetworkRuleMatchers {
  urlPattern?: string;
  methods?: string[];
  graphqlOperation?: GraphQLOperationMatcher;
  hostname?: HostnameMatcher;
  queryParams?: Record<string, RequestKvMatcher>;
  requestHeaders?: Record<string, RequestKvMatcher>;
  resourceTypes?: RequestResourceType[];
  matcher?: string;
  /** Attribution stamp recorded by the engine when a `matcher: 'name'`
   *  reference resolves. Serializable (unlike the internal WeakMap), so debug
   *  events keep the origin name after the config crosses the page boundary.
   *  Setting it by hand only affects debug attribution, never matching. */
  matcherName?: string;
}

/** Common matcher fields for every WebSocket and SSE chaos rule.
 *
 *  WebSocket and SSE expose a SUBSET of the matcher surface that
 *  `NetworkRuleMatchers` carries. Fields omitted here are intentional:
 *  - `methods`: WS opens via a fixed Upgrade handshake; SSE is GET-only.
 *  - `requestHeaders`: neither browser API (`WebSocket`, `EventSource`)
 *    exposes request headers at the constructor surface.
 *  - `resourceTypes`: transport is implicit in the rule category.
 *  - `graphqlOperation`: these are not HTTP-with-JSON-body transports.
 *
 *  A rule is exactly ONE of two shapes:
 *  - inline targeting: any combination of `urlPattern`, `hostname`, and
 *    `queryParams`; `matcher` is forbidden. At least one inline field must be
 *    present (enforced at validation, not at the type level), matching the
 *    `NetworkRuleMatchers` inline surface so `urlPattern` is not mandatory
 *    when `hostname` or `queryParams` already targets the rule.
 *  - named reference: `matcher: 'name'` is required and all inline matcher
 *    fields are forbidden.
 *
 *  The per-rule discriminator fields `direction` (WebSocket) and `eventType`
 *  (SSE) filter within an already-matched stream rather than selecting the
 *  stream itself, so they live on the per-rule type and do not appear here.
 *
 *  A `NamedMatcher` referenced via `matcher: 'name'` may declare any field
 *  the `NamedMatcher` shape allows; the WS/SSE gate evaluates only
 *  `urlPattern`, `hostname`, and `queryParams`. Fields not applicable to the
 *  transport are silently ignored so a single named matcher can target
 *  network, WebSocket, and SSE without per-transport duplication. */
export type TransportRuleMatchers =
  | {
      urlPattern?: string;
      hostname?: HostnameMatcher;
      queryParams?: Record<string, RequestKvMatcher>;
      matcher?: never;
      /** Engine-stamped matcher-origin attribution; see `NetworkRuleMatchers.matcherName`. */
      matcherName?: string;
    }
  | {
      matcher: string;
      urlPattern?: never;
      hostname?: never;
      queryParams?: never;
      matcherName?: string;
    };

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

interface WebSocketDropRule {
  direction: WebSocketDirection;
  probability: number;
}
export type WebSocketDropConfig =
  TransportRuleMatchers & RequestCountingOptions & RuleGroupAssignment & WebSocketDropRule;

interface WebSocketDelayRule {
  direction: WebSocketDirection;
  delayMs: number;
  probability: number;
}
export type WebSocketDelayConfig =
  TransportRuleMatchers & RequestCountingOptions & RuleGroupAssignment & WebSocketDelayRule;

/** Strategies for corrupting WebSocket payloads.
 *  `truncate` and `empty` apply to both text and binary payloads.
 *  `malformed-json` and `wrong-type` apply to text payloads only; when the
 *  actual payload at runtime is binary, corruption is skipped and an event is
 *  emitted with `applied: false`.
 */
export type WebSocketCorruptionStrategy = 'truncate' | 'malformed-json' | 'empty' | 'wrong-type';

interface WebSocketCorruptRule {
  direction: WebSocketDirection;
  strategy: WebSocketCorruptionStrategy;
  probability: number;
}
export type WebSocketCorruptConfig =
  TransportRuleMatchers & RequestCountingOptions & RuleGroupAssignment & WebSocketCorruptRule;

interface WebSocketCloseRule {
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
export type WebSocketCloseConfig =
  TransportRuleMatchers & RequestCountingOptions & RuleGroupAssignment & WebSocketCloseRule;

export interface WebSocketConfig {
  drops?: WebSocketDropConfig[];
  delays?: WebSocketDelayConfig[];
  corruptions?: WebSocketCorruptConfig[];
  closes?: WebSocketCloseConfig[];
  /** Deterministic replay of a captured stream fixture. When a socket URL
   *  matches, real inbound messages are suppressed and the fixture chunks are
   *  dispatched as inbound messages on their own timing. */
  replay?: StreamReplayConfig;
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

interface SSEDropRule {
  eventType?: SSEEventTypeMatcher;
  probability: number;
}
export type SSEDropConfig =
  TransportRuleMatchers & RequestCountingOptions & RuleGroupAssignment & SSEDropRule;

interface SSEDelayRule {
  eventType?: SSEEventTypeMatcher;
  delayMs: number;
  probability: number;
}
export type SSEDelayConfig =
  TransportRuleMatchers & RequestCountingOptions & RuleGroupAssignment & SSEDelayRule;

interface SSECorruptRule {
  eventType?: SSEEventTypeMatcher;
  strategy: SSECorruptionStrategy;
  probability: number;
}
export type SSECorruptConfig =
  TransportRuleMatchers & RequestCountingOptions & RuleGroupAssignment & SSECorruptRule;

interface SSECloseRule {
  /** Delay after `open` before dispatching `error` + closing, in ms. Default 0. */
  afterMs?: number;
  probability: number;
}
export type SSECloseConfig =
  TransportRuleMatchers & RequestCountingOptions & RuleGroupAssignment & SSECloseRule;

export interface SSEConfig {
  drops?: SSEDropConfig[];
  delays?: SSEDelayConfig[];
  corruptions?: SSECorruptConfig[];
  closes?: SSECloseConfig[];
  /** Deterministic replay of a captured stream fixture. When a source URL
   *  matches, real inbound events are suppressed and the fixture chunks are
   *  dispatched as `message` events on their own timing. */
  replay?: StreamReplayConfig;
}

/** Strategies for corrupting fetch-stream chunks.
 *
 *  `truncate` / `malformed-json` / `empty` / `wrong-type` operate on text
 *  chunks (decoded UTF-8); when the chunk is binary and the strategy requires
 *  text (`malformed-json`, `wrong-type`), the rule is skipped and a diagnostic
 *  event is emitted with `applied: false`.
 *
 *  `duplicate` is an emission-level strategy: the chunk is enqueued onto the
 *  downstream `ReadableStream` an additional time (binary-safe; no text
 *  decoding). Use this to test consumer idempotency for AI chat replay,
 *  ticker fan-out, etc. */
export type FetchStreamCorruptionStrategy =
  | 'truncate'
  | 'malformed-json'
  | 'empty'
  | 'wrong-type'
  | 'duplicate';

interface FetchStreamDropRule {
  /** Apply only to a specific chunk index (zero-based). When omitted, the
   *  rule applies probabilistically to every chunk of every matched stream. */
  chunkIndex?: number;
  probability: number;
}
export type FetchStreamDropConfig =
  TransportRuleMatchers & RequestCountingOptions & RuleGroupAssignment & FetchStreamDropRule;

interface FetchStreamDelayRule {
  /** Optional chunk-index gate (zero-based). When set, the delay applies only
   *  to the chunk at that index; when omitted, every chunk is gated by
   *  `probability` independently. */
  chunkIndex?: number;
  delayMs: number;
  probability: number;
}
export type FetchStreamDelayConfig =
  TransportRuleMatchers & RequestCountingOptions & RuleGroupAssignment & FetchStreamDelayRule;

interface FetchStreamCorruptRule {
  chunkIndex?: number;
  /** Match against the decoded UTF-8 text of each chunk.
   *  - `string`  -  case-sensitive substring containment.
   *  - `RegExp`  -  `.test(chunkText)`; `g`/`y` flags rejected at validation time.
   *  Binary chunks (invalid UTF-8) never match; the first binary skip per
   *  connection emits a diagnostic event with `applied: false` and
   *  `reason: 'binary-chunk'`. Combines with `chunkIndex` when both are set. */
  chunkPattern?: string | RegExp;
  strategy: FetchStreamCorruptionStrategy;
  probability: number;
  /** Optional lifecycle tag stamped onto the emitted corruption event's
   *  `detail.phase`. Lets rule authors (and presets) surface semantic markers
   *  such as `ai:tool-call-failed` without a bespoke event type. Rejected at
   *  validation time when combined with the `duplicate` strategy, which keeps
   *  its canonical `ai:chunk-duplicated` phase. */
  phase?: ChaosPhase;
}
export type FetchStreamCorruptConfig =
  TransportRuleMatchers & RequestCountingOptions & RuleGroupAssignment & FetchStreamCorruptRule;

interface FetchStreamCloseRule {
  /** Close (truncate) the stream after this many milliseconds from the first
   *  chunk. Mutually exclusive with `afterChunk`. */
  afterMs?: number;
  /** Close (truncate) the stream after this many chunks have been read.
   *  Mutually exclusive with `afterMs`. */
  afterChunk?: number;
  probability: number;
}
export type FetchStreamCloseConfig =
  TransportRuleMatchers & RequestCountingOptions & RuleGroupAssignment & FetchStreamCloseRule;

/** One captured chunk of a replay fixture. `data` is text (typically a JSON
 *  string). Binary streams are out of scope for replay in this release. */
export interface ReplayChunk {
  /** Absolute offset (ms) from stream start at which the chunk was observed.
   *  Drives inter-chunk timing on replay. */
  offsetMs: number;
  /** Chunk payload as text; encoded to UTF-8 bytes at emit time. */
  data: string;
}

/** A captured stream fixture: plain JSON, committable to the repo, diffable in
 *  PRs. `version` is REQUIRED; a missing or unknown major version is a hard
 *  validation error. `version: 1` backward-compat is committed for the life of
 *  the 0.x line. */
export interface ReplayFixture {
  /** Fixture format version. Only `1` is understood today. */
  version: 1;
  /** Transport the fixture was captured from. The same fixture is reusable
   *  across transports where the wire format is compatible. */
  transport: 'fetch-stream' | 'sse' | 'websocket';
  /** Informational: the URL the stream was captured from. */
  url?: string;
  /** Informational: ISO-8601 capture timestamp. */
  capturedAt?: string;
  /** Synthetic-response status for `blockUpstream` mode (default 200). */
  status?: number;
  /** Synthetic-response headers for `blockUpstream` mode. */
  headers?: Record<string, string>;
  /** Convenience content-type folded into `headers` for `blockUpstream` mode.
   *  Defaults per transport when omitted. */
  contentType?: string;
  /** Ordered captured chunks. Array order is emission order. */
  chunks: ReplayChunk[];
}

/** Chunk-level mutations applied deterministically during replay.
 *
 *  Every mutation addresses ORIGINAL fixture chunk indices (never
 *  running/shifted indices). The engine resolves them in a single pass, sorted
 *  by `(target index, array index)`, so the same fixture + mutations always
 *  yields identical bytes and timing regardless of seed.
 *  - `delay`: pause after chunk N for `ms`, shifting later chunks.
 *  - `truncate`: drop every chunk after N.
 *  - `duplicate`: emit chunk N a second time.
 *  - `split`: break chunk N into two at CHARACTER offset `at`.
 *  - `coalesce`: merge `count` chunks starting at `startChunk` into one.
 *  - `inject-malformed`: insert a new chunk (not in the fixture) after N. */
export type ReplayMutation =
  | { type: 'delay'; afterChunk: number; ms: number }
  | { type: 'truncate'; afterChunk: number }
  | { type: 'duplicate'; chunkIndex: number }
  | { type: 'split'; chunkIndex: number; at: number }
  | { type: 'coalesce'; startChunk: number; count: number }
  | { type: 'inject-malformed'; afterChunk: number; payload: string };

/** Replay directive at the transport level (post-compile). The in-page core
 *  only ever sees inline `data`; a fixture PATH is resolved adapter-side into
 *  `data` before the config crosses the page boundary. The same shape is reused
 *  by fetch-stream, SSE, and WebSocket replay. */
export type StreamReplayConfig = TransportRuleMatchers & {
  /** Inline, already-resolved fixture. */
  data: ReplayFixture;
  /** Deterministic mutations applied during replay. */
  mutations?: ReplayMutation[];
  /** fetch-stream only. When true (DEFAULT), suppress the upstream request and
   *  return a fully synthetic `Response`. When false, let the request fire and
   *  substitute the response body on `.body` access. Ignored by SSE and
   *  WebSocket replay, where the connection always opens and inbound messages
   *  are substituted. */
  blockUpstream?: boolean;
};

/** Alias kept for the fetch-stream surface; identical to {@link StreamReplayConfig}. */
export type FetchStreamReplayConfig = StreamReplayConfig;

export interface FetchStreamConfig {
  drops?: FetchStreamDropConfig[];
  delays?: FetchStreamDelayConfig[];
  corruptions?: FetchStreamCorruptConfig[];
  closes?: FetchStreamCloseConfig[];
  /** Deterministic replay of a captured stream fixture. When set and a request
   *  matches, the consumer is driven from the fixture instead of the network. */
  replay?: FetchStreamReplayConfig;
}

/** Transport selection for AI-namespace rules.
 *  - `'auto'` (default): compile rules into fetch-stream AND sse AND
 *    websocket; the runtime fires whichever transport the consumer actually
 *    uses. First-matched-wins when a single request matches more than one.
 *  - explicit transport: emit rules only into that transport. */
export type AiTransport = 'auto' | 'fetch-stream' | 'sse' | 'websocket';

/** Thin DSL that compiles down to transport rule arrays at engine init.
 *  The compiler (`compileAiToRules`, wired in `prepareChaosConfig`) reads
 *  this slice, expands each field into the matching transport rules, and
 *  appends them via the same append helper presets use.
 *
 *  No field on this interface emits a new transport kind. Every value lands
 *  on `fetchStream` / `sse` / `websocket` so existing report consumers stay
 *  backward compatible; the semantic overlay rides on `detail.phase`. */
/** Replay directive under the `ai` namespace. `fixture` (a path) is resolved
 *  ADAPTER-side into `data`; the in-page core replays only inline `data`. */
export interface AiReplayConfig {
  /** Fixture path, resolved by the adapter's `loadStreamFixture` into `data`.
   *  A path that reaches the in-page core is a validation error. */
  fixture?: string;
  /** Inline, already-resolved fixture. Required at the core boundary. */
  data?: ReplayFixture;
  /** Deterministic mutations applied during replay. */
  mutations?: ReplayMutation[];
  /** fetch-stream only. When true (DEFAULT), suppress the upstream request and
   *  return a fully synthetic `Response`. */
  blockUpstream?: boolean;
  /** URL scope for the replay. Defaults to the fixture's `url`, then `'*'`. */
  urlPattern?: string;
}

export interface AiConfig {
  /** Delay (ms) applied before the first chunk of a matched streaming
   *  response. Compiles to a delay rule gated to `chunkIndex === 0`. */
  firstChunkDelayMs?: number;
  /** Zero-based chunk index after which to pause the stream. Requires
   *  `pauseDurationMs`. Compiles to a delay rule gated to that chunk. */
  pauseAfterChunk?: number;
  /** Pause duration (ms) when `pauseAfterChunk` fires. */
  pauseDurationMs?: number;
  /** Zero-based chunk index after which to close (truncate) the stream.
   *  Compiles to a close rule with `afterChunk`. */
  truncateAfterChunk?: number;
  /** Probability (0..1) of duplicating any given chunk. Compiles to a
   *  corruption rule whose `strategy` is the duplicate variant added in a
   *  later phase of this release. */
  duplicateChunkProbability?: number;
  /** When true, the compiler annotates emitted drop rules so the streaming
   *  interceptor reconnects (rather than abandons) the dropped stream. */
  reconnectAfterDrop?: boolean;
  /** Replay a captured stream fixture (optionally mutated) instead of the live
   *  stream. Compiles to a `replay` directive on the target transport(s). */
  replay?: AiReplayConfig;
  /** Which streaming transport(s) to target. Default `'auto'`. */
  transport?: AiTransport;
}

/** Rapid-fire synthetic retry clicks against a selector, simulating a user
 *  smashing a retry button while a request is failing or a stream is stalled. */
export interface UserInteractionRetryStormConfig {
  /** Number of synthetic clicks to dispatch. */
  count: number;
  /** Gap between consecutive clicks, in ms. */
  intervalMs: number;
  /** Delay from chaos start before the first click, in ms. Default 0. */
  afterMs?: number;
  /** CSS selector for the click target. The first matching element is
   *  re-queried before every click so re-rendered buttons stay reachable.
   *  Default `[data-chaos-retry]`. */
  selector?: string;
}

/** Simulated tab backgrounding: `document.visibilityState` / `document.hidden`
 *  report `'hidden'` / `true` for the duration and a synthetic
 *  `visibilitychange` event fires at both edges. The tab is never actually
 *  backgrounded  -  no driver-level switching. */
export interface UserInteractionTabHiddenConfig {
  /** Delay from chaos start before the tab reports hidden, in ms. */
  afterMs: number;
  /** How long the tab reports hidden before flipping back, in ms. */
  durationMs: number;
}

/** Simulated window focus loss: synthetic `blur` then `focus` events on the
 *  window, `durationMs` apart. Focus state properties are not overridden. */
export interface UserInteractionBlurWindowConfig {
  /** Delay from chaos start before the `blur` event, in ms. */
  afterMs: number;
  /** Gap between the `blur` and the restoring `focus` event, in ms. */
  durationMs: number;
}

/** Simulated prompt edit while a response is still streaming: focuses the
 *  target input and types `text` character by character, spreading the
 *  keystrokes evenly across `simulateTypingMs`. Each character updates
 *  `.value` and dispatches an `input` event. */
export interface UserInteractionPromptEditConfig {
  /** Delay from chaos start before the edit begins, in ms. */
  afterMs: number;
  /** Total duration of the simulated typing, in ms. */
  simulateTypingMs: number;
  /** CSS selector for the input or textarea to edit.
   *  Default `[data-chaos-prompt]`. */
  selector?: string;
  /** Text appended to the input's current value. Default `' (edited)'`. */
  text?: string;
}

/** Simulated mid-stream navigation: `location.assign(target)` fires after
 *  `afterMs`. The page context is torn down by the navigation, so assertions
 *  belong on the destination page or on beforeunload side effects. */
export interface UserInteractionNavigateAwayConfig {
  /** Delay from chaos start before navigating, in ms. */
  afterMs: number;
  /** Navigation target passed to `location.assign`. */
  target: string;
}

/** Human-interaction chaos for streaming UIs. Simulates the user side of
 *  streaming failures: cancelling a response mid-stream, smashing retry,
 *  backgrounding the tab, losing window focus, editing the prompt while
 *  chunks are still arriving, or navigating away.
 *
 *  All triggers fire on a fixed schedule measured from chaos start, so runs
 *  are deterministic without touching the PRNG. Triggers are top-level config
 *  only in spirit but MAY be carried by presets; when several sources set the
 *  same trigger, the later source wins per trigger (user config beats
 *  presets). Requires a DOM for the selector- and document-based triggers;
 *  non-DOM contexts (service workers) skip them with a console warning. */
export interface UserInteractionConfig {
  /** Cancel every in-flight streaming connection after this many ms:
   *  fetch-stream requests abort (the consumer observes a real `AbortError`),
   *  SSE sources and WebSockets close. Connections opened after the trigger
   *  fires are unaffected. */
  cancelStreamAfterMs?: number;
  retryStorm?: UserInteractionRetryStormConfig;
  tabHidden?: UserInteractionTabHiddenConfig;
  blurWindow?: UserInteractionBlurWindowConfig;
  promptEditDuringResponse?: UserInteractionPromptEditConfig;
  navigateAway?: UserInteractionNavigateAwayConfig;
}

export interface ChaosConfig {
  network?: NetworkConfig;
  ui?: UiConfig;
  websocket?: WebSocketConfig;
  sse?: SSEConfig;
  /**
   * Chaos for streams returned from `fetch(...).body.getReader()` and other
   * `ReadableStream` consumers. Targets every consumer of the response body,
   * including SDK wrappers that grab the stream before the user code sees the
   * `Response`. Rules address chunks by zero-based index or by probability.
   */
  fetchStream?: FetchStreamConfig;
  /**
   * Thin DSL for AI-chat-flavored streaming chaos. Compiles into transport
   * rule arrays (`fetchStream`, `sse`, `websocket`) at engine init, with the
   * semantic overlay surfaced through `detail.phase` (e.g. `'ai:first-chunk'`)
   * on the emitted events. Top-level only: presets, profiles, and override
   * slices cannot carry `ai`.
   */
  ai?: AiConfig;
  /**
   * Human-interaction chaos for streaming UIs: cancel mid-stream, retry
   * storms, tab-visibility and focus changes, prompt edits during generation,
   * navigate-away. Triggers fire on a fixed ms schedule from chaos start
   * (deterministic; the PRNG is not consulted) and emit `ui:*` events tagged
   * with `user:*` phases.
   */
  userInteraction?: UserInteractionConfig;
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
   * `console.debug`. Framework-agnostic  -  does not touch
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
   * Preset configs themselves cannot carry `presets` or `customPresets`  - 
   * dependency chains are out of scope and rejected by the schema.
   */
  presets?: string[];
  /**
   * Per-instance custom presets registered alongside the built-ins.
   * Each value is a `PresetConfigSlice` (a `ChaosConfig` minus `presets`,
   * `customPresets`, `seed`, and `debug`). Names collide fail-fast against
   * built-ins and against each other  -  pick a unique label.
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
   * Singular by design  -  a profile IS the named scenario. Multi-profile
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
   * Rule arrays append (never replace)  -  overrides extend the merged rule
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
   * Per-instance registry of reusable named matchers. Each entry is a
   * `NamedMatcher` bundle of matcher fields (`urlPattern`, `hostname`,
   * `methods`, `queryParams`, `headers`, `resourceTypes`, `graphqlOperation`)
   * shared across multiple rules via `matcher: 'name'`.
   *
   * Built-in matchers (`BUILT_IN_MATCHERS`: `graphql`, `apiRequests`,
   * `authRequests`) resolve by name without an entry here. An entry that
   * reuses a built-in name shadows that built-in.
   *
   * Names normalize via `String.prototype.trim()`; collisions throw
   * `ChaosConfigError` with `code: 'matcher_collision'` at construction.
   * Unknown references throw `code: 'matcher_not_found'`. A rule that mixes
   * `matcher` with inline matcher fields throws `code: 'matcher_inline_conflict'`.
   *
   * Resolution slot inside `prepareChaosConfig` is AFTER profile resolution
   * and preset expansion and BEFORE the post-merge Zod pass, so rules brought
   * in by presets or profiles can also reference top-level matchers.
   *
   * Matchers are a top-level registry only  -  presets and profile slices may
   * not declare their own `matchers` field. Recursive composition (a
   * `NamedMatcher` carrying its own `matcher` reference) is out of scope and
   * surfaces as `matcher_cycle` if encountered.
   */
  matchers?: Record<string, NamedMatcher>;
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
