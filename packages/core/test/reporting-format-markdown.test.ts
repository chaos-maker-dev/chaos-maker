import { describe, expect, it } from 'vitest';
import type { ChaosEvent } from '../src/events';
import { buildChaosReport } from '../src/reporting/build';
import { formatReportMarkdown } from '../src/reporting/format-markdown';

const FIXED_NOW = 1_700_000_000_000;

function richReport() {
  const events: ChaosEvent[] = [
    {
      type: 'network:failure',
      timestamp: 1000,
      applied: true,
      detail: {
        ruleId: 'r1',
        ruleType: 'failure',
        statusCode: 503,
        url: '/api/x',
      },
    },
    {
      type: 'debug',
      timestamp: 1100,
      applied: false,
      detail: { stage: 'rule-skip-match', ruleId: 'r2', skippedAt: 'urlPattern' },
    },
  ];
  return buildChaosReport(events, { now: FIXED_NOW, seed: 42, title: 'checkout flow' });
}

describe('formatReportMarkdown', () => {
  it('renders the meta block with title, seed snippet, counts, and duration', () => {
    const out = formatReportMarkdown(richReport());
    expect(out.startsWith('# Chaos report: checkout flow\n')).toBe(true);
    expect(out).toContain('**Seed**: `chaos seed: 42`');
    expect(out).toContain('**Events**: 2 (applied 1, skipped 1)');
    expect(out).toContain('**Duration**: 100 ms');
  });

  it('falls back to "Chaos run" when title is null and renders "-" duration for empty events', () => {
    const empty = buildChaosReport([], { now: FIXED_NOW });
    const out = formatReportMarkdown(empty);
    expect(out.startsWith('# Chaos report: Chaos run\n')).toBe(true);
    expect(out).toContain('**Duration**: -');
  });

  it('renders one section per area with the exact headers', () => {
    const out = formatReportMarkdown(richReport());
    expect(out).toContain('## Rule hits');
    expect(out).toContain('## Transports');
    expect(out).toContain('## Skip reasons');
    expect(out).toContain('## Failures');
    expect(out).toContain('## Timeline');
  });

  it('shows _No X._ for every empty section', () => {
    const empty = buildChaosReport([], { now: FIXED_NOW });
    const out = formatReportMarkdown(empty);
    expect(out).toContain('_No rule hits._');
    expect(out).toContain('_No transport activity._');
    expect(out).toContain('_No skips recorded._');
    expect(out).toContain('_No failures recorded._');
    expect(out).toContain('_No events recorded._');
  });

  it('escapes pipes inside table cells so rows stay well-formed', () => {
    const events: ChaosEvent[] = [
      {
        type: 'network:failure',
        timestamp: 0,
        applied: true,
        detail: {
          ruleId: 'r|pipe',
          ruleType: 'failure',
          statusCode: 503,
          url: '/api/has|pipe',
        },
      },
    ];
    const out = formatReportMarkdown(buildChaosReport(events, { now: FIXED_NOW }));
    expect(out).toContain('`r\\|pipe`');
    expect(out).toContain('/api/has\\|pipe');
  });

  it('renders timeline entries with relative offsetMs prefixes', () => {
    const out = formatReportMarkdown(richReport());
    expect(out).toContain('- `+0ms`');
    expect(out).toContain('- `+100ms`');
    expect(out).toContain('(rule `r1`)');
  });
});
