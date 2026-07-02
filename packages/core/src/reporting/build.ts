import type { ChaosEvent } from '../events';
import type { ChaosDebugStage } from '../events';
import { formatSeedReproduction } from '../seed-reporting';
import { formatStepTitle } from '../format-event';
import { classifyTransport } from './transport';
import type {
  BuildChaosReportOptions,
  ChaosReport,
  ConnectionLifecycleEntry,
  ConnectionSummary,
  FailureSummary,
  PhaseSummary,
  RuleHitSummary,
  SkipReasonSummary,
  StreamingReadinessSummary,
  StreamingTransportReadiness,
  TimelineEntry,
  TransportKind,
  TransportSummary,
} from './types';

const SKIP_STAGES: ReadonlySet<ChaosDebugStage> = new Set<ChaosDebugStage>([
  'rule-skip-match',
  'rule-skip-counting',
  'rule-skip-group',
  'rule-skip-probability',
]);

const FAILURE_TYPES: ReadonlySet<string> = new Set([
  'network:failure',
  'network:abort',
  'network:cors',
  'network:corruption',
]);

function isOutcomeEvent(event: ChaosEvent): boolean {
  const t = event.type;
  return (
    t.startsWith('network:') ||
    t.startsWith('websocket:') ||
    t.startsWith('sse:') ||
    t.startsWith('fetch-stream:') ||
    t.startsWith('ui:')
  );
}

/** Streaming phase tags live in the `ai:` / `user:` namespaces. Engine
 *  lifecycle markers (`engine:start`, `sw:install`, ...) share the `phase`
 *  detail slot but are not streaming phases. */
function streamingPhaseOf(event: ChaosEvent): string | null {
  const phase = event.detail?.phase;
  if (typeof phase !== 'string') return null;
  return phase.startsWith('ai:') || phase.startsWith('user:') ? phase : null;
}

function isSkipDebugEvent(event: ChaosEvent): event is ChaosEvent & {
  detail: { stage: ChaosDebugStage };
} {
  if (event.type !== 'debug') return false;
  const stage = event.detail?.stage;
  return stage !== undefined && SKIP_STAGES.has(stage);
}

function isFailureEvent(event: ChaosEvent): boolean {
  if (!event.applied) return false;
  if (FAILURE_TYPES.has(event.type)) return true;
  const status = event.detail?.statusCode;
  return typeof status === 'number' && status >= 500;
}

function cmpString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Build a deterministic structured report from a chaos event log. Pure
 *  function: same `(events, opts)` always produces the same report. `opts.now`
 *  injects a fixed timestamp for tests; production callers omit it and accept
 *  `Date.now()` on the `meta.generatedAt` field. */
export function buildChaosReport(
  events: ChaosEvent[],
  opts: BuildChaosReportOptions = {},
): ChaosReport {
  const seed = opts.seed ?? null;
  const now = opts.now ?? Date.now();
  const title = opts.title ?? null;

  const eventCount = events.length;
  let appliedCount = 0;
  let skippedCount = 0;
  for (const event of events) {
    if (isOutcomeEvent(event) && event.applied) appliedCount++;
    if (isSkipDebugEvent(event)) skippedCount++;
  }
  const durationMs =
    events.length >= 2
      ? events[events.length - 1].timestamp - events[0].timestamp
      : null;

  // Rule attribution is sourced from the debug stream, since today only
  // `emitter.debug(...)` decorates events with `detail.ruleId`/`detail.ruleType`
  // via the engine's rule-id WeakMap. Outcome events (`network:*` etc.) carry
  // url/method/statusCode but not ruleId, so a run without `debug: true`
  // produces empty `ruleHits`. Top-level `meta.appliedCount` / `transports` /
  // `failures` / `timeline` aggregate fine without debug mode.
  type RuleAggregate = {
    applied: number;
    skipped: number;
    types: Set<string>;
    ruleName: string | null;
  };
  const ruleMap = new Map<string, RuleAggregate>();
  for (const event of events) {
    const ruleId = event.detail?.ruleId;
    if (!ruleId) continue;
    let agg = ruleMap.get(ruleId);
    if (!agg) {
      agg = { applied: 0, skipped: 0, types: new Set(), ruleName: null };
      ruleMap.set(ruleId, agg);
    }
    if (event.detail?.ruleType) agg.types.add(event.detail.ruleType);
    if (event.detail?.ruleName && !agg.ruleName) {
      agg.ruleName = event.detail.ruleName;
    }
    if (event.type === 'debug' && event.detail?.stage === 'rule-applied') {
      agg.applied++;
    } else if (isSkipDebugEvent(event)) {
      agg.skipped++;
    } else if (isOutcomeEvent(event) && event.applied) {
      // Outcome events that DO carry a ruleId (future engine work) count here
      // too. Today this branch is unreachable but kept so the semantics stay
      // future-proof when ruleId is added to the outcome emit sites.
      agg.applied++;
    }
  }
  const ruleHits: RuleHitSummary[] = Array.from(ruleMap.entries())
    .map(([ruleId, agg]) => ({
      ruleId,
      ruleName: agg.ruleName,
      applied: agg.applied,
      skipped: agg.skipped,
      total: agg.applied + agg.skipped,
      types: Array.from(agg.types).sort(cmpString),
    }))
    .sort(
      (a, b) =>
        b.applied - a.applied ||
        b.skipped - a.skipped ||
        cmpString(a.ruleId, b.ruleId),
    );

  type TransportAggregate = { events: number; applied: number };
  const transportMap = new Map<TransportKind, TransportAggregate>();
  for (const event of events) {
    const kind = classifyTransport(event);
    if (!kind) continue;
    let agg = transportMap.get(kind);
    if (!agg) {
      agg = { events: 0, applied: 0 };
      transportMap.set(kind, agg);
    }
    agg.events++;
    if (event.applied) agg.applied++;
  }
  const transports: TransportSummary[] = Array.from(transportMap.entries())
    .map(([kind, agg]) => ({ kind, events: agg.events, applied: agg.applied }))
    .sort((a, b) => b.events - a.events || cmpString(a.kind, b.kind));

  const skipMap = new Map<
    string,
    { stage: ChaosDebugStage; skippedAt: string | null; count: number }
  >();
  for (const event of events) {
    if (!isSkipDebugEvent(event)) continue;
    const stage = event.detail.stage;
    const skippedAt = event.detail.skippedAt ?? null;
    // Tuple-stringified key avoids collisions if `stage` or `skippedAt` ever
    // contain the delimiter. Stable across runtimes (no Unicode normalization).
    const key = JSON.stringify([stage, skippedAt]);
    let agg = skipMap.get(key);
    if (!agg) {
      agg = { stage, skippedAt, count: 0 };
      skipMap.set(key, agg);
    }
    agg.count++;
  }
  const skipReasons: SkipReasonSummary[] = Array.from(skipMap.values()).sort(
    (a, b) =>
      b.count - a.count ||
      cmpString(a.stage, b.stage) ||
      cmpString(a.skippedAt ?? '', b.skippedAt ?? ''),
  );

  const failureMap = new Map<string, FailureSummary>();
  for (const event of events) {
    if (!isFailureEvent(event)) continue;
    const ruleId = event.detail?.ruleId ?? null;
    const statusCode = event.detail?.statusCode ?? null;
    // Tuple-stringified key avoids collisions if `ruleId` or `type` ever
    // contain the delimiter (future-proof for user-supplied rule names).
    const key = JSON.stringify([ruleId, event.type, statusCode]);
    let agg = failureMap.get(key);
    if (!agg) {
      agg = {
        ruleId,
        type: event.type,
        statusCode,
        count: 0,
        sampleUrl: event.detail?.url ?? null,
      };
      failureMap.set(key, agg);
    }
    agg.count++;
  }
  const failures: FailureSummary[] = Array.from(failureMap.values()).sort(
    (a, b) =>
      b.count - a.count ||
      cmpString(a.ruleId ?? '', b.ruleId ?? '') ||
      cmpString(a.type, b.type) ||
      (a.statusCode ?? -1) - (b.statusCode ?? -1),
  );

  const baseTs = events.length > 0 ? events[0].timestamp : 0;
  const timeline: TimelineEntry[] = events.map((event) => ({
    offsetMs: event.timestamp - baseTs,
    type: event.type,
    applied: event.applied,
    ruleId: event.detail?.ruleId ?? null,
    ruleType: event.detail?.ruleType ?? null,
    matcherName: event.detail?.matcherName ?? null,
    phase: streamingPhaseOf(event),
    chunkIndex: typeof event.detail?.chunkIndex === 'number' ? event.detail.chunkIndex : null,
    connectionId: typeof event.detail?.connectionId === 'string' ? event.detail.connectionId : null,
    title: formatStepTitle(event),
  }));

  // Streaming phase aggregates, keyed by (phase, transport).
  const phaseMap = new Map<string, PhaseSummary>();
  for (const event of events) {
    const phase = streamingPhaseOf(event);
    if (!phase) continue;
    const kind = classifyTransport(event);
    if (!kind) continue;
    const key = JSON.stringify([phase, kind]);
    let agg = phaseMap.get(key);
    if (!agg) {
      agg = { phase, transport: kind, count: 0, applied: 0 };
      phaseMap.set(key, agg);
    }
    agg.count++;
    if (event.applied) agg.applied++;
  }
  const phases: PhaseSummary[] = Array.from(phaseMap.values()).sort(
    (a, b) =>
      b.count - a.count ||
      cmpString(a.phase, b.phase) ||
      cmpString(a.transport, b.transport),
  );

  // Per-connection lifecycle timelines. Any event carrying a connectionId
  // joins its connection's ordered entry list; phase markers derive the
  // summary flags. Pause resolution is per connection: a pause is unresolved
  // when no later resume event exists on the same connection.
  type ConnectionAggregate = {
    connectionId: string;
    transport: TransportKind;
    url: string | null;
    firstOffsetMs: number;
    firstChunkOffsetMs: number | null;
    pauses: number;
    resumes: number;
    truncated: boolean;
    replayed: boolean;
    entries: ConnectionLifecycleEntry[];
  };
  const connectionMap = new Map<string, ConnectionAggregate>();
  for (const event of events) {
    const connectionId = event.detail?.connectionId;
    if (typeof connectionId !== 'string') continue;
    const kind = classifyTransport(event);
    if (!kind) continue;
    const offsetMs = event.timestamp - baseTs;
    let agg = connectionMap.get(connectionId);
    if (!agg) {
      agg = {
        connectionId,
        transport: kind,
        url: event.detail?.url ?? null,
        firstOffsetMs: offsetMs,
        firstChunkOffsetMs: null,
        pauses: 0,
        resumes: 0,
        truncated: false,
        replayed: false,
        entries: [],
      };
      connectionMap.set(connectionId, agg);
    }
    const phase = streamingPhaseOf(event);
    if (phase === 'ai:first-chunk' && agg.firstChunkOffsetMs === null) {
      agg.firstChunkOffsetMs = offsetMs;
    } else if (phase === 'ai:stream-paused') {
      agg.pauses++;
    } else if (phase === 'ai:stream-resumed') {
      agg.resumes++;
    } else if (phase === 'ai:stream-truncated') {
      agg.truncated = true;
    } else if (phase === 'ai:stream-replayed') {
      agg.replayed = true;
    }
    agg.entries.push({
      offsetMs,
      type: event.type,
      applied: event.applied,
      phase,
      chunkIndex: typeof event.detail?.chunkIndex === 'number' ? event.detail.chunkIndex : null,
      title: formatStepTitle(event),
    });
  }
  const connections: ConnectionSummary[] = Array.from(connectionMap.values())
    .map((agg) => ({
      connectionId: agg.connectionId,
      transport: agg.transport,
      url: agg.url,
      events: agg.entries.length,
      firstChunkOffsetMs: agg.firstChunkOffsetMs,
      pauses: agg.pauses,
      unresolvedPauses: Math.max(0, agg.pauses - agg.resumes),
      truncated: agg.truncated,
      replayed: agg.replayed,
      entries: agg.entries,
    }))
    .sort((a, b) => {
      const aFirst = connectionMap.get(a.connectionId)!.firstOffsetMs;
      const bFirst = connectionMap.get(b.connectionId)!.firstOffsetMs;
      return aFirst - bFirst || cmpString(a.connectionId, b.connectionId);
    });

  // Readiness scorecard: pure counts over the connection summaries. `null`
  // when the run streamed nothing, so non-streaming reports stay compact.
  let streamingReadiness: StreamingReadinessSummary | null = null;
  if (connections.length > 0) {
    const byTransportMap = new Map<TransportKind, StreamingTransportReadiness>();
    let truncated = 0;
    let replayed = 0;
    let unresolvedPauses = 0;
    let completedWithoutInterruption = 0;
    for (const conn of connections) {
      let slice = byTransportMap.get(conn.transport);
      if (!slice) {
        slice = { kind: conn.transport, connections: 0, truncated: 0, replayed: 0, unresolvedPauses: 0 };
        byTransportMap.set(conn.transport, slice);
      }
      slice.connections++;
      if (conn.truncated) {
        truncated++;
        slice.truncated++;
      }
      if (conn.replayed) {
        replayed++;
        slice.replayed++;
      }
      unresolvedPauses += conn.unresolvedPauses;
      slice.unresolvedPauses += conn.unresolvedPauses;
      if (!conn.truncated && conn.unresolvedPauses === 0) completedWithoutInterruption++;
    }
    streamingReadiness = {
      connections: connections.length,
      completedWithoutInterruption,
      truncated,
      replayed,
      unresolvedPauses,
      byTransport: Array.from(byTransportMap.values()).sort(
        (a, b) => b.connections - a.connections || cmpString(a.kind, b.kind),
      ),
    };
  }

  return {
    meta: {
      title,
      generatedAt: now,
      seed,
      eventCount,
      appliedCount,
      skippedCount,
      durationMs,
      replaySnippet: formatSeedReproduction(seed),
    },
    ruleHits,
    transports,
    skipReasons,
    failures,
    phases,
    connections,
    streamingReadiness,
    timeline,
  };
}
