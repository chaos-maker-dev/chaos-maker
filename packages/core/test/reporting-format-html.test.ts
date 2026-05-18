import { describe, expect, it } from 'vitest';
import type { ChaosEvent } from '../src/events';
import { buildChaosReport } from '../src/reporting/build';
import { formatReportHtml } from '../src/reporting/format-html';

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

describe('formatReportHtml', () => {
  it('renders a complete self-contained HTML document', () => {
    const out = formatReportHtml(richReport());
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out.includes('<html lang="en">')).toBe(true);
    expect(out.includes('<style>')).toBe(true);
    expect(out.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('contains no <script> tags and no external URLs', () => {
    const out = formatReportHtml(richReport());
    expect(out.toLowerCase().includes('<script')).toBe(false);
    expect(out.includes('http://')).toBe(false);
    expect(out.includes('https://')).toBe(false);
  });

  it('escapes HTML-significant characters in user-supplied fields', () => {
    const events: ChaosEvent[] = [
      {
        type: 'network:failure',
        timestamp: 0,
        applied: true,
        detail: {
          ruleId: '<script>alert(1)</script>',
          statusCode: 503,
          url: '"&\'<>',
        },
      },
    ];
    const out = formatReportHtml(
      buildChaosReport(events, { now: FIXED_NOW, title: '<bad>' }),
    );
    expect(out.includes('<script>alert(1)</script>')).toBe(false);
    expect(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe(true);
    expect(out.includes('&quot;&amp;&#39;&lt;&gt;')).toBe(true);
    expect(out.includes('&lt;bad&gt;')).toBe(true);
  });

  it('renders timeline entries with relative offsets and applied/skipped classes', () => {
    const out = formatReportHtml(richReport());
    expect(out).toContain('<ol class="timeline">');
    expect(out).toContain('<span class="offset">+0ms</span>');
    expect(out).toContain('<span class="offset">+100ms</span>');
    expect(out).toContain('class="applied"');
    expect(out).toContain('class="skipped"');
  });

  it('places generatedAt only in the data attribute, not as a free-floating timestamp string', () => {
    const out = formatReportHtml(richReport());
    const occurrences = (out.match(/1700000000000/g) ?? []).length;
    // appears twice: once as data-generated-at attribute, once as the dd text content
    expect(occurrences).toBe(2);
  });

  it('renders "No X." messages when sections are empty', () => {
    const out = formatReportHtml(buildChaosReport([], { now: FIXED_NOW }));
    expect(out).toContain('No rule hits.');
    expect(out).toContain('No transport activity.');
    expect(out).toContain('No skips recorded.');
    expect(out).toContain('No failures recorded.');
    expect(out).toContain('No events recorded.');
  });

  it('uses the supplied opts.title for the document title and h1', () => {
    const report = buildChaosReport([], { now: FIXED_NOW, title: 'ignored' });
    const out = formatReportHtml(report, { title: 'chosen' });
    expect(out).toContain('<title>Chaos report: chosen</title>');
    expect(out).toContain('<h1>Chaos report: chosen</h1>');
  });
});
