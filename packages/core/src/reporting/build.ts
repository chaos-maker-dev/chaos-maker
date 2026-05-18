import type { ChaosEvent } from '../events';
import type { ChaosDebugStage } from '../events';
import { formatSeedReproduction } from '../seed-reporting';
import { formatStepTitle } from '../format-event';
import { classifyTransport } from './transport';
import type {
  BuildChaosReportOptions,
  ChaosReport,
  FailureSummary,
  RuleHitSummary,
  SkipReasonSummary,
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
    t.startsWith('ui:')
  );
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
    const key = `${stage}|${skippedAt ?? ''}`;
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
    const key = `${ruleId ?? ''}|${event.type}|${statusCode ?? ''}`;
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
    title: formatStepTitle(event),
  }));

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
    timeline,
  };
}
