import type { ChaosDebugStage } from '../events';

/** Coarse transport bucket used by the reporting layer. `'network'` is the
 *  union of fetch and XHR because the current `ChaosEvent.detail` shape does
 *  not distinguish them. Splitting that bucket requires a new `subtransport`
 *  field on `ChaosEvent.detail`, which is intentionally out of scope here.
 *
 *  `'fetch-stream'` is its own bucket (NOT folded into `'network'`) because the
 *  interceptor wraps `Response.body` AFTER the request has resolved, and the
 *  reporting layer surfaces chunk-level lifecycle (`phase` / `chunkIndex`)
 *  rather than request-level outcomes. Tools that aggregate by `kind` should
 *  treat the two as distinct transports. */
export type TransportKind =
  | 'network'
  | 'websocket'
  | 'sse'
  | 'fetch-stream'
  | 'ui'
  | 'rule-group';

export interface BuildChaosReportOptions {
  /** Seed echoed into `report.meta.seed`. When omitted or `null`, the report
   *  records the seed as unknown and `replaySnippet` falls back to
   *  `'chaos seed: <not injected>'`. */
  seed?: number | null;
  /** Override for `report.meta.generatedAt`. Tests inject a fixed value so the
   *  formatter output is byte-identical across runs. Defaults to `Date.now()`. */
  now?: number;
  /** Optional human label echoed into `report.meta.title` and the HTML
   *  `<title>` tag. */
  title?: string;
}

export interface ChaosReportMeta {
  title: string | null;
  generatedAt: number;
  seed: number | null;
  eventCount: number;
  appliedCount: number;
  skippedCount: number;
  durationMs: number | null;
  replaySnippet: string;
}

export interface RuleHitSummary {
  ruleId: string;
  ruleName: string | null;
  applied: number;
  skipped: number;
  total: number;
  types: string[];
}

export interface TransportSummary {
  kind: TransportKind;
  events: number;
  applied: number;
}

export interface SkipReasonSummary {
  stage: ChaosDebugStage;
  skippedAt: string | null;
  count: number;
}

export interface FailureSummary {
  ruleId: string | null;
  type: string;
  statusCode: number | null;
  count: number;
  sampleUrl: string | null;
}

export interface TimelineEntry {
  offsetMs: number;
  type: string;
  applied: boolean;
  ruleId: string | null;
  ruleType: string | null;
  matcherName: string | null;
  /** Streaming lifecycle tag carried by the event (`ai:*` / `user:*`), or
   *  `null` for non-streaming entries. Passed through verbatim; renderers
   *  must not reinterpret canonical values. */
  phase: string | null;
  /** Zero-based chunk index within the emitting connection, when present. */
  chunkIndex: number | null;
  /** Stable per-connection identifier, when present. */
  connectionId: string | null;
  title: string;
}

/** Count of events carrying one streaming phase value on one transport.
 *  Only `ai:` / `user:` namespaced phases aggregate here; engine lifecycle
 *  markers (`engine:start`, ...) stay out of the streaming summary. */
export interface PhaseSummary {
  phase: string;
  transport: TransportKind;
  count: number;
  applied: number;
}

/** One event on a single connection's ordered lifecycle timeline. */
export interface ConnectionLifecycleEntry {
  offsetMs: number;
  type: string;
  applied: boolean;
  phase: string | null;
  chunkIndex: number | null;
  title: string;
}

/** Everything the report knows about one streamed connection, keyed by the
 *  `connectionId` the interceptor minted. `firstChunkOffsetMs` is the offset
 *  of the `ai:first-chunk` marker relative to the log start; `unresolvedPauses`
 *  counts `ai:stream-paused` events with no later `ai:stream-resumed` on the
 *  same connection (a stall the stream never recovered from). */
export interface ConnectionSummary {
  connectionId: string;
  transport: TransportKind;
  url: string | null;
  events: number;
  firstChunkOffsetMs: number | null;
  pauses: number;
  unresolvedPauses: number;
  truncated: boolean;
  replayed: boolean;
  entries: ConnectionLifecycleEntry[];
}

/** Per-transport slice of the streaming readiness summary. */
export interface StreamingTransportReadiness {
  kind: TransportKind;
  connections: number;
  truncated: number;
  replayed: number;
  unresolvedPauses: number;
}

/** Deterministic scorecard for streaming smoke tests: counts and flags only,
 *  derived entirely from the local event log. `completedWithoutInterruption`
 *  counts connections with no truncation and no unresolved pause. */
export interface StreamingReadinessSummary {
  connections: number;
  completedWithoutInterruption: number;
  truncated: number;
  replayed: number;
  unresolvedPauses: number;
  byTransport: StreamingTransportReadiness[];
}

export interface ChaosReport {
  meta: ChaosReportMeta;
  ruleHits: RuleHitSummary[];
  transports: TransportSummary[];
  skipReasons: SkipReasonSummary[];
  failures: FailureSummary[];
  /** Streaming phase aggregates. Empty for runs with no streaming events. */
  phases: PhaseSummary[];
  /** Per-connection streaming timelines. Empty for non-streaming runs. */
  connections: ConnectionSummary[];
  /** Streaming readiness scorecard, or `null` when the run produced no
   *  streamed connections. Additive and optional for report consumers. */
  streamingReadiness: StreamingReadinessSummary | null;
  timeline: TimelineEntry[];
}
