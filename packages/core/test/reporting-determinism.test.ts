import { describe, expect, it } from 'vitest';
import type { ChaosEvent } from '../src/events';
import {
  buildChaosReport,
  formatReportHtml,
  formatReportJson,
  formatReportMarkdown,
} from '../src';

const FIXED_NOW = 1_700_000_000_000;

function fixture(): ChaosEvent[] {
  return [
    {
      type: 'network:failure',
      timestamp: 1000,
      applied: true,
      detail: { ruleId: 'r1', ruleType: 'failure', statusCode: 503, url: '/api/a' },
    },
    {
      type: 'network:latency',
      timestamp: 1500,
      applied: true,
      detail: { ruleId: 'r2', ruleType: 'latency', delayMs: 250, url: '/api/b' },
    },
    {
      type: 'debug',
      timestamp: 1700,
      applied: false,
      detail: { stage: 'rule-skip-match', ruleId: 'r3', skippedAt: 'urlPattern' },
    },
    {
      type: 'websocket:drop',
      timestamp: 2000,
      applied: true,
      detail: { ruleId: 'r4', direction: 'inbound' },
    },
  ];
}

describe('reporting determinism', () => {
  it('two builds with the same inputs are deeply equal', () => {
    const a = buildChaosReport(fixture(), { now: FIXED_NOW, seed: 7, title: 'run' });
    const b = buildChaosReport(fixture(), { now: FIXED_NOW, seed: 7, title: 'run' });
    expect(a).toEqual(b);
  });

  it('JSON, Markdown, and HTML outputs are byte-identical across runs', () => {
    const r1 = buildChaosReport(fixture(), { now: FIXED_NOW, seed: 7, title: 'run' });
    const r2 = buildChaosReport(fixture(), { now: FIXED_NOW, seed: 7, title: 'run' });
    expect(formatReportJson(r1)).toBe(formatReportJson(r2));
    expect(formatReportJson(r1, { pretty: false })).toBe(formatReportJson(r2, { pretty: false }));
    expect(formatReportMarkdown(r1)).toBe(formatReportMarkdown(r2));
    expect(formatReportHtml(r1)).toBe(formatReportHtml(r2));
  });

  it('exports the full reporting API from the package entry', () => {
    expect(typeof buildChaosReport).toBe('function');
    expect(typeof formatReportJson).toBe('function');
    expect(typeof formatReportMarkdown).toBe('function');
    expect(typeof formatReportHtml).toBe('function');
  });
});
