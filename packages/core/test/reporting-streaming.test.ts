import { describe, expect, it } from 'vitest';
import type { ChaosEvent } from '../src/events';
import { buildChaosReport } from '../src/reporting/build';

const FIXED_NOW = 1_700_000_000_000;

function ev(
  type: ChaosEvent['type'],
  applied: boolean,
  detail: ChaosEvent['detail'] = {},
  timestamp = 1000,
): ChaosEvent {
  return { type, timestamp, applied, detail };
}

const CONN_A = 'conn-a';
const CONN_B = 'conn-b';

function streamRun(): ChaosEvent[] {
  return [
    ev('fetch-stream:lifecycle', true, { url: '/chat', connectionId: CONN_A, chunkIndex: 0, phase: 'ai:first-chunk' }, 1000),
    ev('fetch-stream:chunk-delayed', true, { url: '/chat', connectionId: CONN_A, chunkIndex: 0, delayMs: 400, phase: 'ai:stream-paused' }, 1010),
    ev('fetch-stream:lifecycle', true, { url: '/chat', connectionId: CONN_A, chunkIndex: 0, phase: 'ai:stream-resumed' }, 1410),
    ev('fetch-stream:truncated', true, { url: '/chat', connectionId: CONN_A, chunkIndex: 3, phase: 'ai:stream-truncated' }, 1600),
    ev('sse:lifecycle', true, { url: '/events', connectionId: CONN_B, chunkIndex: 0, phase: 'ai:first-chunk' }, 1200),
    ev('sse:lifecycle', true, { url: '/events', connectionId: CONN_B, chunkIndex: 4, phase: 'ai:stream-paused' }, 1500),
  ];
}

describe('buildChaosReport.phases', () => {
  it('aggregates streaming phases per (phase, transport)', () => {
    const report = buildChaosReport(streamRun(), { now: FIXED_NOW });
    const key = (p: string, t: string) =>
      report.phases.find((s) => s.phase === p && s.transport === t);
    expect(key('ai:first-chunk', 'fetch-stream')).toMatchObject({ count: 1, applied: 1 });
    expect(key('ai:first-chunk', 'sse')).toMatchObject({ count: 1, applied: 1 });
    expect(key('ai:stream-paused', 'fetch-stream')).toMatchObject({ count: 1 });
    expect(key('ai:stream-truncated', 'fetch-stream')).toMatchObject({ count: 1 });
  });

  it('excludes engine lifecycle phases from the streaming summary', () => {
    const events: ChaosEvent[] = [
      ev('debug', false, { stage: 'lifecycle', phase: 'engine:start' }),
      ev('network:failure', true, { statusCode: 503 }),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.phases).toEqual([]);
  });

  it('is empty for a run with no streaming events', () => {
    const report = buildChaosReport([ev('network:failure', true)], { now: FIXED_NOW });
    expect(report.phases).toEqual([]);
    expect(report.connections).toEqual([]);
    expect(report.streamingReadiness).toBeNull();
  });
});

describe('buildChaosReport.connections', () => {
  it('groups events per connectionId in first-seen order with ordered entries', () => {
    const report = buildChaosReport(streamRun(), { now: FIXED_NOW });
    expect(report.connections.map((c) => c.connectionId)).toEqual([CONN_A, CONN_B]);
    const a = report.connections[0]!;
    expect(a.transport).toBe('fetch-stream');
    expect(a.url).toBe('/chat');
    expect(a.events).toBe(4);
    expect(a.entries.map((e) => e.phase)).toEqual([
      'ai:first-chunk',
      'ai:stream-paused',
      'ai:stream-resumed',
      'ai:stream-truncated',
    ]);
    expect(a.entries.map((e) => e.offsetMs)).toEqual([0, 10, 410, 600]);
  });

  it('derives firstChunkOffsetMs, pause resolution, and truncation flags', () => {
    const report = buildChaosReport(streamRun(), { now: FIXED_NOW });
    const a = report.connections[0]!;
    expect(a.firstChunkOffsetMs).toBe(0);
    expect(a.pauses).toBe(1);
    expect(a.unresolvedPauses).toBe(0);
    expect(a.truncated).toBe(true);
    const b = report.connections[1]!;
    expect(b.firstChunkOffsetMs).toBe(200);
    expect(b.pauses).toBe(1);
    expect(b.unresolvedPauses).toBe(1);
    expect(b.truncated).toBe(false);
  });

  it('does not let a resume settle a pause that has not happened yet', () => {
    const events: ChaosEvent[] = [
      ev('fetch-stream:lifecycle', true, { url: '/chat', connectionId: CONN_A, chunkIndex: 0, phase: 'ai:stream-resumed' }, 1000),
      ev('fetch-stream:chunk-delayed', true, { url: '/chat', connectionId: CONN_A, chunkIndex: 1, delayMs: 400, phase: 'ai:stream-paused' }, 1100),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    const a = report.connections[0]!;
    expect(a.pauses).toBe(1);
    expect(a.unresolvedPauses).toBe(1);
  });

  it('resolves interleaved pause and resume pairs in order', () => {
    const events: ChaosEvent[] = [
      ev('fetch-stream:chunk-delayed', true, { url: '/chat', connectionId: CONN_A, chunkIndex: 0, delayMs: 400, phase: 'ai:stream-paused' }, 1000),
      ev('fetch-stream:lifecycle', true, { url: '/chat', connectionId: CONN_A, chunkIndex: 0, phase: 'ai:stream-resumed' }, 1100),
      ev('fetch-stream:chunk-delayed', true, { url: '/chat', connectionId: CONN_A, chunkIndex: 2, delayMs: 400, phase: 'ai:stream-paused' }, 1200),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    const a = report.connections[0]!;
    expect(a.pauses).toBe(2);
    expect(a.unresolvedPauses).toBe(1);
  });

  it('flags replayed connections', () => {
    const events = [
      ev('fetch-stream:lifecycle', true, { connectionId: CONN_A, chunkIndex: 0, phase: 'ai:stream-replayed' }, 1000),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.connections[0]!.replayed).toBe(true);
  });
});

describe('buildChaosReport.streamingReadiness', () => {
  it('summarizes counts across connections and per transport', () => {
    const report = buildChaosReport(streamRun(), { now: FIXED_NOW });
    const r = report.streamingReadiness!;
    expect(r.connections).toBe(2);
    // CONN_A truncated, CONN_B has an unresolved pause: neither completes clean.
    expect(r.completedWithoutInterruption).toBe(0);
    expect(r.truncated).toBe(1);
    expect(r.unresolvedPauses).toBe(1);
    const fetchSlice = r.byTransport.find((t) => t.kind === 'fetch-stream')!;
    expect(fetchSlice).toMatchObject({ connections: 1, truncated: 1, unresolvedPauses: 0 });
    const sseSlice = r.byTransport.find((t) => t.kind === 'sse')!;
    expect(sseSlice).toMatchObject({ connections: 1, truncated: 0, unresolvedPauses: 1 });
  });

  it('counts clean connections as completedWithoutInterruption', () => {
    const events = [
      ev('fetch-stream:lifecycle', true, { connectionId: CONN_A, chunkIndex: 0, phase: 'ai:first-chunk' }, 1000),
    ];
    const report = buildChaosReport(events, { now: FIXED_NOW });
    expect(report.streamingReadiness!.completedWithoutInterruption).toBe(1);
  });
});

describe('buildChaosReport.timeline streaming passthrough', () => {
  it('carries phase, chunkIndex, and connectionId on timeline entries', () => {
    const report = buildChaosReport(streamRun(), { now: FIXED_NOW });
    const first = report.timeline[0]!;
    expect(first.phase).toBe('ai:first-chunk');
    expect(first.chunkIndex).toBe(0);
    expect(first.connectionId).toBe(CONN_A);
    const nonStreaming = buildChaosReport([ev('network:failure', true)], { now: FIXED_NOW });
    expect(nonStreaming.timeline[0]).toMatchObject({ phase: null, chunkIndex: null, connectionId: null });
  });
});

describe('buildChaosReport.meta fetch-stream outcomes', () => {
  it('counts applied fetch-stream events toward appliedCount', () => {
    const report = buildChaosReport(streamRun(), { now: FIXED_NOW });
    expect(report.meta.appliedCount).toBe(6);
  });

  it('produces a fetch-stream transport summary entry', () => {
    const report = buildChaosReport(streamRun(), { now: FIXED_NOW });
    const fs = report.transports.find((t) => t.kind === 'fetch-stream')!;
    expect(fs).toMatchObject({ events: 4, applied: 4 });
  });
});
