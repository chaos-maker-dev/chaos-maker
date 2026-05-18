import { describe, expect, it } from 'vitest';
import type { ChaosEvent, ChaosDebugStage } from '../src/events';
import { buildChaosReport } from '../src/reporting/build';

const FIXED_NOW = 1_700_000_000_000;

function outcome(
  type: ChaosEvent['type'],
  applied: boolean,
  detail: ChaosEvent['detail'] = {},
  timestamp = 1000,
): ChaosEvent {
  return { type, timestamp, applied, detail };
}

function skipDebug(
  stage: ChaosDebugStage,
  detail: ChaosEvent['detail'] = {},
  timestamp = 1000,
): ChaosEvent {
  return { type: 'debug', timestamp, applied: false, detail: { ...detail, stage } };
}

describe('buildChaosReport.meta', () => {
  it('counts only outcome events with applied:true toward appliedCount', () => {
    const events: ChaosEvent[] = [
      outcome('network:failure', true, { ruleId: 'r1' }),
      outcome('network:failure', false, { ruleId: 'r1' }),
      // admin events excluded
      outcome('rule-group:enabled', true, { groupName: 'g' }),
      outcome('rule-group:disabled', true, { groupName: 'g' }),
      // debug.rule-applied is debug stream, not outcome
      { type: 'debug', timestamp: 1000, applied: true, detail: { stage: 'rule-applied', ruleId: 'r1' } },
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.meta.appliedCount).toBe(1);
  });

  it('counts only debug skip-stage events toward skippedCount and ignores rule-group:gated', () => {
    const events: ChaosEvent[] = [
      skipDebug('rule-skip-match', { skippedAt: 'urlPattern' }),
      skipDebug('rule-skip-counting'),
      skipDebug('rule-skip-group', { groupName: 'g' }),
      skipDebug('rule-skip-probability'),
      // not a skip stage
      skipDebug('rule-evaluating'),
      skipDebug('rule-matched'),
      // outcome event must not double-count the same gate
      outcome('rule-group:gated', false, { groupName: 'g' }),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.meta.skippedCount).toBe(4);
  });

  it('computes durationMs as last.timestamp - first.timestamp; null when <2 events', () => {
    expect(buildChaosReport([], { now: FIXED_NOW }).meta.durationMs).toBeNull();
    expect(
      buildChaosReport([outcome('network:failure', true, {}, 500)], { now: FIXED_NOW }).meta.durationMs,
    ).toBeNull();
    const report = buildChaosReport(
      [
        outcome('network:failure', true, {}, 500),
        outcome('network:latency', true, {}, 1750),
      ],
      { now: FIXED_NOW },
    );
    expect(report.meta.durationMs).toBe(1250);
  });

  it('renders replaySnippet from formatSeedReproduction', () => {
    const withSeed = buildChaosReport([], { now: FIXED_NOW, seed: 42 });
    expect(withSeed.meta.replaySnippet).toBe('chaos seed: 42');
    const noSeed = buildChaosReport([], { now: FIXED_NOW });
    expect(noSeed.meta.replaySnippet).toBe('chaos seed: <not injected>');
    expect(noSeed.meta.seed).toBeNull();
  });

  it('echoes title and now into meta', () => {
    const report = buildChaosReport([], { now: FIXED_NOW, title: 'checkout flow' });
    expect(report.meta.title).toBe('checkout flow');
    expect(report.meta.generatedAt).toBe(FIXED_NOW);
  });

  it('empty events: zero counts and empty arrays', () => {
    const report = buildChaosReport([], { now: FIXED_NOW });
    expect(report.meta.eventCount).toBe(0);
    expect(report.meta.appliedCount).toBe(0);
    expect(report.meta.skippedCount).toBe(0);
    expect(report.meta.durationMs).toBeNull();
    expect(report.ruleHits).toEqual([]);
    expect(report.transports).toEqual([]);
    expect(report.skipReasons).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.timeline).toEqual([]);
  });
});

describe('buildChaosReport.ruleHits', () => {
  it('groups by ruleId, excludes events with no ruleId, and sorts applied desc / skipped desc / ruleId asc', () => {
    const events: ChaosEvent[] = [
      outcome('network:failure', true, { ruleId: 'b', ruleType: 'failure' }),
      outcome('network:failure', true, { ruleId: 'b', ruleType: 'failure' }),
      outcome('network:latency', true, { ruleId: 'a', ruleType: 'latency' }),
      outcome('network:latency', true, { ruleId: 'a', ruleType: 'latency' }),
      skipDebug('rule-skip-match', { ruleId: 'a', skippedAt: 'urlPattern', ruleType: 'latency' }),
      skipDebug('rule-skip-match', { ruleId: 'c', skippedAt: 'urlPattern', ruleType: 'failure' }),
      // no ruleId → ignored
      outcome('network:failure', true, {}),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.ruleHits.map((r) => r.ruleId)).toEqual(['a', 'b', 'c']);
    expect(report.ruleHits[0]).toMatchObject({
      ruleId: 'a',
      applied: 2,
      skipped: 1,
      total: 3,
      types: ['latency'],
    });
    expect(report.ruleHits[1]).toMatchObject({
      ruleId: 'b',
      applied: 2,
      skipped: 0,
      total: 2,
    });
    expect(report.ruleHits[2]).toMatchObject({
      ruleId: 'c',
      applied: 0,
      skipped: 1,
      total: 1,
    });
  });

  it('collects every distinct ruleType seen for a rule and sorts them', () => {
    const events: ChaosEvent[] = [
      outcome('network:failure', true, { ruleId: 'r1', ruleType: 'failure' }),
      outcome('network:latency', true, { ruleId: 'r1', ruleType: 'latency' }),
      skipDebug('rule-skip-match', { ruleId: 'r1', ruleType: 'abort', skippedAt: 'methods' }),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.ruleHits[0].types).toEqual(['abort', 'failure', 'latency']);
  });

  it('counts debug rule-applied stage toward ruleHits.applied (real engine attribution path)', () => {
    const events: ChaosEvent[] = [
      // Outcome event with no ruleId (matches today's engine behavior)
      outcome('network:failure', true, { statusCode: 503, url: '/api/x' }, 1000),
      // Debug rule-applied stage carries the rule attribution via the WeakMap
      { type: 'debug', timestamp: 1001, applied: false, detail: { stage: 'rule-applied', ruleId: 'failure#0', ruleType: 'failure' } },
      { type: 'debug', timestamp: 1100, applied: false, detail: { stage: 'rule-applied', ruleId: 'failure#0', ruleType: 'failure' } },
      // Same rule, one skip
      skipDebug('rule-skip-probability', { ruleId: 'failure#0', ruleType: 'failure' }),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.ruleHits).toEqual([
      {
        ruleId: 'failure#0',
        ruleName: null,
        applied: 2,
        skipped: 1,
        total: 3,
        types: ['failure'],
      },
    ]);
  });

  it('captures first seen ruleName for a rule', () => {
    const events: ChaosEvent[] = [
      outcome('network:failure', true, { ruleId: 'r1', ruleName: 'slow-api' }),
      outcome('network:failure', true, { ruleId: 'r1', ruleName: 'IGNORED-LATER' }),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.ruleHits[0].ruleName).toBe('slow-api');
  });
});

describe('buildChaosReport.transports', () => {
  it('collapses every network:* subtype to one network row and sorts events desc / kind asc', () => {
    const events: ChaosEvent[] = [
      outcome('network:failure', true, {}),
      outcome('network:latency', true, {}),
      outcome('network:abort', false, {}),
      outcome('websocket:drop', true, {}),
      outcome('sse:close', true, {}),
      outcome('sse:delay', true, {}),
      outcome('sse:drop', false, {}),
      outcome('ui:assault', true, {}),
      { type: 'debug', timestamp: 1000, applied: false, detail: { stage: 'rule-matched' } },
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.transports).toEqual([
      { kind: 'network', events: 3, applied: 2 },
      { kind: 'sse', events: 3, applied: 2 },
      { kind: 'ui', events: 1, applied: 1 },
      { kind: 'websocket', events: 1, applied: 1 },
    ]);
  });
});

describe('buildChaosReport.skipReasons', () => {
  it('groups by {stage, skippedAt} with null for non-rule-skip-match stages', () => {
    const events: ChaosEvent[] = [
      skipDebug('rule-skip-match', { skippedAt: 'urlPattern' }),
      skipDebug('rule-skip-match', { skippedAt: 'urlPattern' }),
      skipDebug('rule-skip-match', { skippedAt: 'methods' }),
      skipDebug('rule-skip-counting'),
      skipDebug('rule-skip-group', { groupName: 'gated' }),
      skipDebug('rule-skip-group', { groupName: 'other' }),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.skipReasons).toEqual([
      { stage: 'rule-skip-group', skippedAt: null, count: 2 },
      { stage: 'rule-skip-match', skippedAt: 'urlPattern', count: 2 },
      { stage: 'rule-skip-counting', skippedAt: null, count: 1 },
      { stage: 'rule-skip-match', skippedAt: 'methods', count: 1 },
    ]);
  });
});

describe('buildChaosReport.failures', () => {
  it('groups status >= 500 plus failure-class network types and sorts count desc / ruleId asc / type asc / status asc', () => {
    const events: ChaosEvent[] = [
      outcome('network:failure', true, { ruleId: 'r1', statusCode: 503, url: '/api/a' }),
      outcome('network:failure', true, { ruleId: 'r1', statusCode: 503, url: '/api/b' }),
      outcome('network:failure', true, { ruleId: 'r1', statusCode: 500, url: '/api/c' }),
      outcome('network:abort', true, { ruleId: 'r2', url: '/api/d' }),
      outcome('network:cors', true, { ruleId: 'r2', url: '/api/e' }),
      outcome('network:corruption', true, { ruleId: 'r1', url: '/api/f' }),
      // status 200 is not a failure
      outcome('network:latency', true, { ruleId: 'r3', statusCode: 200 }),
      // not applied → excluded
      outcome('network:failure', false, { ruleId: 'r1', statusCode: 503 }),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.failures).toEqual([
      { ruleId: 'r1', type: 'network:failure', statusCode: 503, count: 2, sampleUrl: '/api/a' },
      { ruleId: 'r1', type: 'network:corruption', statusCode: null, count: 1, sampleUrl: '/api/f' },
      { ruleId: 'r1', type: 'network:failure', statusCode: 500, count: 1, sampleUrl: '/api/c' },
      { ruleId: 'r2', type: 'network:abort', statusCode: null, count: 1, sampleUrl: '/api/d' },
      { ruleId: 'r2', type: 'network:cors', statusCode: null, count: 1, sampleUrl: '/api/e' },
    ]);
  });

  it('captures sampleUrl from the first matching event in each group', () => {
    const events: ChaosEvent[] = [
      outcome('network:failure', true, { ruleId: 'r1', statusCode: 503, url: '/first' }),
      outcome('network:failure', true, { ruleId: 'r1', statusCode: 503, url: '/second' }),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.failures[0].sampleUrl).toBe('/first');
  });
});

describe('buildChaosReport.timeline', () => {
  it('preserves input order and computes offsetMs from the first event timestamp', () => {
    const events: ChaosEvent[] = [
      outcome('network:failure', true, { ruleId: 'r1', url: '/api/x' }, 1000),
      outcome('network:latency', true, { ruleId: 'r2' }, 1750),
      skipDebug('rule-skip-match', { ruleId: 'r1', skippedAt: 'methods' }, 2200),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.timeline.map((e) => e.offsetMs)).toEqual([0, 750, 1200]);
    expect(report.timeline.map((e) => e.type)).toEqual([
      'network:failure',
      'network:latency',
      'debug',
    ]);
    expect(report.timeline[0].title).toContain('chaos:network:failure');
    expect(report.timeline[0].ruleId).toBe('r1');
  });
});
