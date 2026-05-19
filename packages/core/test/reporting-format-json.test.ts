import { describe, expect, it } from 'vitest';
import type { ChaosEvent } from '../src/events';
import { buildChaosReport } from '../src/reporting/build';
import { formatReportJson } from '../src/reporting/format-json';

const FIXED_NOW = 1_700_000_000_000;

function fixtureEvents(): ChaosEvent[] {
  return [
    { type: 'network:failure', timestamp: 1000, applied: true, detail: { ruleId: 'r1', ruleType: 'failure', statusCode: 503, url: '/api/x' } },
    { type: 'debug', timestamp: 1100, applied: false, detail: { stage: 'rule-skip-match', ruleId: 'r2', skippedAt: 'urlPattern' } },
  ];
}

describe('formatReportJson', () => {
  it('pretty mode indents with two spaces and ends with a trailing newline', () => {
    const report = buildChaosReport(fixtureEvents(), { now: FIXED_NOW, seed: 42 });
    const out = formatReportJson(report);
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('\n  "meta": {');
    expect(out).toContain('\n    "seed": 42');
  });

  it('compact mode produces a single line with no trailing newline', () => {
    const report = buildChaosReport(fixtureEvents(), { now: FIXED_NOW, seed: 42 });
    const out = formatReportJson(report, { pretty: false });
    expect(out.includes('\n')).toBe(false);
    expect(out.startsWith('{')).toBe(true);
    expect(out.endsWith('}')).toBe(true);
  });

  it('round-trips back to the same report', () => {
    const report = buildChaosReport(fixtureEvents(), { now: FIXED_NOW, seed: 42 });
    const parsed = JSON.parse(formatReportJson(report));
    expect(parsed).toEqual(report);
  });

  it('preserves key order: meta, ruleHits, transports, skipReasons, failures, timeline', () => {
    const report = buildChaosReport(fixtureEvents(), { now: FIXED_NOW, seed: 42 });
    const out = formatReportJson(report, { pretty: false });
    const indices = [
      out.indexOf('"meta"'),
      out.indexOf('"ruleHits"'),
      out.indexOf('"transports"'),
      out.indexOf('"skipReasons"'),
      out.indexOf('"failures"'),
      out.indexOf('"timeline"'),
    ];
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });

  it('contains no absolute Date.now-style timestamps in the rendered body beyond meta.generatedAt', () => {
    const report = buildChaosReport(fixtureEvents(), { now: FIXED_NOW, seed: 42 });
    const out = formatReportJson(report, { pretty: false });
    const occurrences = (out.match(/1700000000000/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
