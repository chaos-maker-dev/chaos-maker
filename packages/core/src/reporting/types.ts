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
  title: string;
}

export interface ChaosReport {
  meta: ChaosReportMeta;
  ruleHits: RuleHitSummary[];
  transports: TransportSummary[];
  skipReasons: SkipReasonSummary[];
  failures: FailureSummary[];
  timeline: TimelineEntry[];
}
