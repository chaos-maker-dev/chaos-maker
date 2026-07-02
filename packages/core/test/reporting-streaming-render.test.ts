import { describe, expect, it } from 'vitest';
import type { ChaosEvent } from '../src/events';
import { buildChaosReport } from '../src/reporting/build';
import { formatReportMarkdown } from '../src/reporting/format-markdown';
import { formatReportHtml } from '../src/reporting/format-html';
import { formatReportJson } from '../src/reporting/format-json';

const FIXED_NOW = 1_700_000_000_000;

function ev(
  type: ChaosEvent['type'],
  applied: boolean,
  detail: ChaosEvent['detail'] = {},
  timestamp = 1000,
): ChaosEvent {
  return { type, timestamp, applied, detail };
}

const STREAM_EVENTS: ChaosEvent[] = [
  ev('fetch-stream:lifecycle', true, { url: '/chat', connectionId: 'conn-a', chunkIndex: 0, phase: 'ai:first-chunk' }, 1000),
  ev('fetch-stream:chunk-delayed', true, { url: '/chat', connectionId: 'conn-a', chunkIndex: 0, delayMs: 400, phase: 'ai:stream-paused' }, 1010),
  ev('fetch-stream:truncated', true, { url: '/chat', connectionId: 'conn-a', chunkIndex: 3, phase: 'ai:stream-truncated' }, 1600),
];

const NON_STREAM_EVENTS: ChaosEvent[] = [
  ev('network:failure', true, { url: '/api', statusCode: 503 }, 1000),
  ev('network:latency', true, { url: '/api', delayMs: 200 }, 1100),
];

describe('formatReportMarkdown streaming sections', () => {
  it('renders phase, readiness, and connection sections for a streaming run', () => {
    const md = formatReportMarkdown(buildChaosReport(STREAM_EVENTS, { now: FIXED_NOW, seed: 42 }));
    expect(md).toContain('## Streaming phases');
    expect(md).toContain('`ai:first-chunk`');
    expect(md).toContain('## Streaming readiness');
    expect(md).toContain('**Connections**: 1 (0 completed without interruption)');
    expect(md).toContain('## Connections');
    expect(md).toContain('### Connection `conn-a` (fetch-stream) **truncated, 1 unresolved pause(s)**');
    expect(md).toContain('first chunk at +0ms');
  });

  it('annotates timeline entries with phase and chunk index', () => {
    const md = formatReportMarkdown(buildChaosReport(STREAM_EVENTS, { now: FIXED_NOW }));
    expect(md).toMatch(/`\+10ms` .* `ai:stream-paused` chunk 0/);
  });

  it('omits streaming sections entirely for a non-streaming run', () => {
    const md = formatReportMarkdown(buildChaosReport(NON_STREAM_EVENTS, { now: FIXED_NOW }));
    expect(md).not.toContain('Streaming phases');
    expect(md).not.toContain('Streaming readiness');
    expect(md).not.toContain('## Connections');
  });

  it('is deterministic for a fixed report', () => {
    const report = buildChaosReport(STREAM_EVENTS, { now: FIXED_NOW, seed: 42 });
    expect(formatReportMarkdown(report)).toBe(formatReportMarkdown(report));
  });
});

describe('formatReportHtml streaming sections', () => {
  it('renders phase chips, readiness, and connection timelines', () => {
    const html = formatReportHtml(buildChaosReport(STREAM_EVENTS, { now: FIXED_NOW, seed: 42 }));
    expect(html).toContain('<summary>Streaming phases</summary>');
    expect(html).toContain('<span class="phase">ai:first-chunk</span>');
    expect(html).toContain('<span class="chunk">chunk 3</span>');
    expect(html).toContain('<summary>Streaming readiness</summary>');
    expect(html).toContain('<summary>Connections</summary>');
    expect(html).toContain('<code>conn-a</code>');
    expect(html).toContain('truncated');
  });

  it('stays self-contained: no script tags or external URLs', () => {
    const html = formatReportHtml(buildChaosReport(STREAM_EVENTS, { now: FIXED_NOW }));
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/src=["']https?:/);
    expect(html).not.toMatch(/href=["']https?:/);
  });

  it('omits streaming sections for a non-streaming run', () => {
    const html = formatReportHtml(buildChaosReport(NON_STREAM_EVENTS, { now: FIXED_NOW }));
    expect(html).not.toContain('Streaming phases');
    expect(html).not.toContain('Streaming readiness');
    expect(html).not.toContain('<summary>Connections</summary>');
  });

  it('escapes attacker-controlled phase-adjacent fields', () => {
    const events = [
      ev('fetch-stream:lifecycle', true, {
        url: '/chat?<img src=x onerror=alert(1)>',
        connectionId: '<b>conn</b>',
        chunkIndex: 0,
        phase: 'ai:first-chunk',
      }),
    ];
    const html = formatReportHtml(buildChaosReport(events, { now: FIXED_NOW }));
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>conn</b>');
  });
});

describe('formatReportJson streaming fields', () => {
  it('carries the new report fields through serialization', () => {
    const report = buildChaosReport(STREAM_EVENTS, { now: FIXED_NOW, seed: 42 });
    const parsed = JSON.parse(formatReportJson(report)) as Record<string, unknown>;
    expect(Array.isArray(parsed.phases)).toBe(true);
    expect(Array.isArray(parsed.connections)).toBe(true);
    expect(parsed.streamingReadiness).toMatchObject({ connections: 1, truncated: 1 });
  });

  it('serializes null readiness for non-streaming runs', () => {
    const report = buildChaosReport(NON_STREAM_EVENTS, { now: FIXED_NOW });
    const parsed = JSON.parse(formatReportJson(report)) as Record<string, unknown>;
    expect(parsed.streamingReadiness).toBeNull();
    expect(parsed.phases).toEqual([]);
  });
});
