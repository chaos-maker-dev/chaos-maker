import type { Logger, RuleIdEntry } from './debug';

export type ChaosEventType =
  | 'network:failure'
  | 'network:latency'
  | 'network:abort'
  | 'network:corruption'
  | 'network:cors'
  | 'ui:assault'
  | 'websocket:drop'
  | 'websocket:delay'
  | 'websocket:corrupt'
  | 'websocket:close'
  | 'sse:drop'
  | 'sse:delay'
  | 'sse:corrupt'
  | 'sse:close'
  /** A chunk of a wrapped fetch-stream response was withheld from the consumer. */
  | 'fetch-stream:chunk-dropped'
  /** A chunk of a wrapped fetch-stream response was delayed before being enqueued. */
  | 'fetch-stream:chunk-delayed'
  /** A chunk of a wrapped fetch-stream response was mutated (truncate / malformed-json / empty / wrong-type). */
  | 'fetch-stream:chunk-corrupted'
  /** A chunk of a wrapped fetch-stream response was enqueued more than once. */
  | 'fetch-stream:chunk-duplicated'
  /** A wrapped fetch-stream response was closed before the upstream finished. */
  | 'fetch-stream:truncated'
  /** Streaming lifecycle marker for a wrapped fetch-stream response.
   *  `detail.phase` carries the canonical phase string (e.g. `'ai:first-chunk'`). */
  | 'fetch-stream:lifecycle'
  /** Streaming lifecycle marker for an SSE connection. `detail.phase` carries
   *  the canonical phase string. */
  | 'sse:lifecycle'
  /** Streaming lifecycle marker for inbound WebSocket traffic.
   *  `detail.phase` carries the canonical phase string. */
  | 'websocket:lifecycle'
  /** Emitted once per `enableGroup()` call. `applied: true`. */
  | 'rule-group:enabled'
  /** Emitted once per `disableGroup()` call. `applied: true`. */
  | 'rule-group:disabled'
  /** Emitted once per group per toggle cycle when a rule is skipped because
   *  its group is disabled. Deduped  -  at most one event per group between
   *  toggles to avoid log floods. `applied: false`. */
  | 'rule-group:gated'
  /** Single Debug Mode event type. The concrete stage of the rule
   *  decision pipeline lives on `detail.stage`. `applied: false`. */
  | 'debug';

/** Stage taxonomy. Stable strings used as `detail.stage` on every
 *  `type: 'debug'` event. Defined here (not in `debug.ts`) so the event-detail
 *  union can reference it without a circular runtime import. */
export type ChaosDebugStage =
  | 'rule-evaluating'
  | 'rule-matched'
  | 'rule-skip-match'
  | 'rule-skip-counting'
  | 'rule-skip-group'
  | 'rule-skip-probability'
  | 'rule-applied'
  | 'lifecycle';

/** Lifecycle phases. Set on `detail.phase` only when
 *  `detail.stage === 'lifecycle'`. WS/SSE direction continues to live on
 *  the existing `detail.direction` field. */
export type ChaosLifecyclePhase =
  | 'engine:start'
  | 'engine:stop'
  | 'engine:group-toggled'
  | 'sw:install'
  | 'sw:config-applied'
  | 'sw:config-stopped'
  | 'sw:group-toggled';

/** Streaming-lifecycle marker. Optional on `ChaosEvent.detail`.
 *
 *  Format: `<namespace>:<lifecycle>` in kebab-case. Namespaces:
 *    - `ai:`  - streaming chaos (first-chunk, pause, resume, truncate, ...)
 *    - `user:` - human-interaction chaos (reserved for the human-interaction
 *      release; not emitted by the current build).
 *
 *  This type is OPTIONAL and ADDITIVE on every event detail. Consumers that
 *  ignore it stay backward compatible. Reporting / replay layers read it
 *  verbatim and MUST NOT reinterpret the canonical values listed below. */
export type ChaosPhase =
  | `ai:${string}`
  | `user:${string}`;

/** Canonical streaming phase values shipped today. Reporting renderers may
 *  add styling for these specific strings; the runtime does NOT rename them
 *  in future releases. New phases are appended as additional kebab strings
 *  in the same namespace. */
export type StreamingChaosPhase =
  | 'ai:first-chunk'
  | 'ai:stream-paused'
  | 'ai:stream-resumed'
  | 'ai:stream-truncated'
  | 'ai:chunk-duplicated'
  | 'ai:stream-replayed'
  | 'ai:tool-call-failed';

export interface ChaosEvent {
  type: ChaosEventType;
  timestamp: number;
  applied: boolean;
  detail: {
    url?: string;
    method?: string;
    statusCode?: number;
    delayMs?: number;
    timeoutMs?: number;
    strategy?: string;
    selector?: string;
    action?: string;
    /** WebSocket message direction (for `websocket:*` events). */
    direction?: 'inbound' | 'outbound';
    /** WebSocket payload kind (for `websocket:*` events). */
    payloadType?: 'text' | 'binary';
    /** WebSocket close code (for `websocket:close` events). */
    closeCode?: number;
    /** WebSocket close reason (for `websocket:close` events). */
    closeReason?: string;
    /** SSE event type (for `sse:*` events). `'message'` is the spec default. */
    eventType?: string;
    /** GraphQL operation name (for `network:*` events when the request was
     *  detected as a GraphQL operation). Pivot on this to slice events by
     *  operation in dashboards / assertions. */
    operationName?: string;
    /** Reason string for diagnostic `applied: false` events. */
    reason?: string;
    /** Group name (for `rule-group:*` events, and on gated rule diagnostics). */
    groupName?: string;
    /** New state of a group when `stage === 'lifecycle'` and
     *  `phase === 'engine:group-toggled' | 'sw:group-toggled'`. Distinguishes
     *  enable from disable on the debug stream so consumers don't have to
     *  pivot on the parallel `rule-group:enabled` / `rule-group:disabled`
     *  emitter events. */
    enabled?: boolean;
    /** Concrete stage of a rule's decision pipeline. Set on every
     *  `type: 'debug'` event; unset on non-debug events. */
    stage?: ChaosDebugStage;
    /** Lifecycle or streaming phase marker.
     *
     *  - `ChaosLifecyclePhase` values (`engine:start`, `sw:install`, ...) ride
     *    only on `stage === 'lifecycle'` debug events.
     *  - `ChaosPhase` values (`ai:first-chunk`, `user:cancel`, ...) ride on
     *    transport events from streaming interceptors (fetch-stream, sse, ws)
     *    so report consumers can surface a chunk-level timeline without
     *    inspecting `type`. */
    phase?: ChaosLifecyclePhase | ChaosPhase;
    /** Rule category  -  `'failure' | 'latency' | 'abort' | ...`. */
    ruleType?: string;
    /** Deterministic identifier for a specific rule WITHIN A SINGLE
     *  CONFIG SNAPSHOT. Positional: reordering rules in your config changes
     *  the IDs. Sufficient for in-test diagnostic pinpointing in v0.5.0. */
    ruleId?: string;
    /** Optional human label for a rule (future builder field).
     *  Reserved so the event shape doesn't churn when the builder later
     *  gains `.failRequests({..., name: 'slow-api'})`. */
    ruleName?: string;
    /** Name of the registered `NamedMatcher` whose fields were inlined into
     *  this rule by `resolveNamedMatchers`. Set on every event emitted for a
     *  matcher-resolved rule (including `rule-matched` debug events). */
    matcherName?: string;
    /** Sorted list of matcher fields beyond `urlPattern`/`methods` that fired
     *  for a `rule-matched` debug event. Useful for explaining WHY a rule
     *  fired in dashboards. Possible values: `'hostname' | 'queryParams' |
     *  'requestHeaders' | 'resourceTypes' | 'graphqlOperation'`. */
    matchedBy?: string[];
    /** Name of the first matcher field that failed for a `rule-skip-match`
     *  debug event. One of the matcher field names. */
    skippedAt?: string;
    /** Zero-based chunk index within a single streamed response or event
     *  source. Populated by streaming interceptors so consumers can attribute
     *  a chunk event back to its position in the stream. */
    chunkIndex?: number;
    /** Stable per-connection identifier minted by streaming interceptors
     *  (UUID v4 when `crypto.randomUUID` is available, monotonic counter
     *  otherwise). Lets reporting and replay layers correlate chunks
     *  belonging to the same response when transports multiplex. */
    connectionId?: string;
    /** Source byte length of the chunk before any mutation. Set on
     *  fetch-stream chunk events so reporting can compute total bytes
     *  dropped/duplicated without re-reading the stream. */
    chunkBytes?: number;
  };
}

export type ChaosEventListener = (event: ChaosEvent) => void;

export class ChaosEventEmitter {
  private listeners: Map<string, Set<ChaosEventListener>> = new Map();
  private log: ChaosEvent[] = [];
  private logger: Logger | undefined;
  private ruleIds: WeakMap<object, RuleIdEntry> | undefined;

  constructor(private readonly maxLogEntries = 2000) {}

  on(type: ChaosEventType | '*', listener: ChaosEventListener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  off(type: ChaosEventType | '*', listener: ChaosEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(event: ChaosEvent): void {
    this.log.push(event);
    if (this.log.length > this.maxLogEntries) {
      this.log.shift();
    }

    this.notify(this.listeners.get(event.type), event);
    this.notify(this.listeners.get('*'), event);
  }

  /** Attach a Debug Mode logger. When unset, `debug()` is a fast-path no-op. */
  setLogger(logger: Logger | undefined): void {
    this.logger = logger;
  }

  /** Attach the rule-id map so debug events auto-resolve `ruleType` /
   *  `ruleId` from a rule object reference. */
  setRuleIds(map: WeakMap<object, RuleIdEntry> | undefined): void {
    this.ruleIds = map;
  }

  /**
   * Emit a Debug Mode event. Fast-path no-op when no logger is attached  - 
   * single undefined-check before any allocation. When `rule` is supplied
   * and present in the rule-id map, `detail.ruleType` and `detail.ruleId`
   * are filled in automatically.
   */
  debug(stage: ChaosDebugStage, detail: ChaosEvent['detail'], rule?: object): void {
    if (!this.logger) return;
    const id = rule ? this.ruleIds?.get(rule) : undefined;
    let finalDetail: ChaosEvent['detail'] = detail;
    if (id) {
      finalDetail = { ...finalDetail, ruleType: id.ruleType, ruleId: id.ruleId };
      if (id.matcherName !== undefined) {
        finalDetail = { ...finalDetail, matcherName: id.matcherName };
      }
    }
    const evt = this.logger.log(stage, finalDetail);
    // Logger.log() returns null when constructed with enabled:false. The
    // fast-path above already skips the call when no logger is attached, but
    // an external caller could have wired in a disabled Logger directly.
    if (!evt) return;
    this.emit(evt);
  }

  getLog(): ChaosEvent[] {
    return [...this.log];
  }

  clearLog(): void {
    this.log = [];
  }

  private notify(listeners: Set<ChaosEventListener> | undefined, event: ChaosEvent): void {
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // prevent listener errors from breaking emitter flow
      }
    }
  }
}
