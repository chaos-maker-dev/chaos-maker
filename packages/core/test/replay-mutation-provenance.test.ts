import { describe, expect, it } from 'vitest';
import { applyMutations, parseFixture } from '../src/ai/replay';
import { buildChaosReport } from '../src/reporting/build';
import { formatReportMarkdown } from '../src/reporting/format-markdown';
import type { ChaosEvent } from '../src/events';
import type { ReplayFixture } from '../src/config';

const FIXTURE: ReplayFixture = parseFixture({
  version: 1,
  transport: 'fetch-stream',
  chunks: [
    { offsetMs: 0, data: 'alpha' },
    { offsetMs: 100, data: 'bravo' },
    { offsetMs: 200, data: 'charlie' },
    { offsetMs: 300, data: 'delta' },
  ],
});

describe('applyMutations mutation provenance', () => {
  it('stamps mutationIndex on pieces rewritten by split and coalesce', () => {
    const plan = applyMutations(FIXTURE, [
      { type: 'split', chunkIndex: 0, at: 2 },
      { type: 'coalesce', startChunk: 2, count: 2 },
    ]);
    const head = plan.pieces.find((p) => p.kind === 'split-head')!;
    const tail = plan.pieces.find((p) => p.kind === 'split-tail')!;
    const merged = plan.pieces.find((p) => p.kind === 'coalesce')!;
    expect(head.mutationIndex).toBe(0);
    expect(tail.mutationIndex).toBe(0);
    expect(merged.mutationIndex).toBe(1);
  });

  it('stamps mutationIndex on duplicate and inject pieces', () => {
    const plan = applyMutations(FIXTURE, [
      { type: 'duplicate', chunkIndex: 1 },
      { type: 'inject-malformed', afterChunk: 2, payload: '{"broken' },
    ]);
    const dup = plan.pieces.find((p) => p.kind === 'duplicate')!;
    const injected = plan.pieces.find((p) => p.kind === 'inject-malformed')!;
    expect(dup.mutationIndex).toBe(0);
    expect(injected.mutationIndex).toBe(1);
  });

  it('records the pause and truncation mutation indices', () => {
    const plan = applyMutations(FIXTURE, [
      { type: 'delay', afterChunk: 0, ms: 500 },
      { type: 'truncate', afterChunk: 2 },
    ]);
    const paused = plan.pieces.find((p) => p.pauseBeforeMs !== undefined)!;
    expect(paused.pauseMutationIndex).toBe(0);
    expect(plan.truncated).toBe(true);
    expect(plan.truncatedBy).toBe(1);
  });

  it('attributes a stacked pause to the largest contributing delay', () => {
    const plan = applyMutations(FIXTURE, [
      { type: 'delay', afterChunk: 0, ms: 200 },
      { type: 'delay', afterChunk: 0, ms: 700 },
      { type: 'delay', afterChunk: 0, ms: 300 },
    ]);
    const paused = plan.pieces.find((p) => p.pauseBeforeMs !== undefined)!;
    expect(paused.pauseBeforeMs).toBe(1200);
    expect(paused.pauseMutationIndex).toBe(1);
  });

  it('breaks pause attribution ties toward the earlier mutation', () => {
    const plan = applyMutations(FIXTURE, [
      { type: 'delay', afterChunk: 1, ms: 500 },
      { type: 'delay', afterChunk: 1, ms: 500 },
    ]);
    const paused = plan.pieces.find((p) => p.pauseBeforeMs !== undefined)!;
    expect(paused.pauseBeforeMs).toBe(1000);
    expect(paused.pauseMutationIndex).toBe(0);
  });

  it('leaves untouched original pieces unstamped', () => {
    const plan = applyMutations(FIXTURE, [{ type: 'duplicate', chunkIndex: 1 }]);
    const originals = plan.pieces.filter((p) => p.kind === 'original');
    expect(originals.every((p) => p.mutationIndex === undefined)).toBe(true);
  });
});

describe('mutation attribution in reports', () => {
  function replayedEvents(): ChaosEvent[] {
    return [
      {
        type: 'fetch-stream:lifecycle',
        timestamp: 1000,
        applied: true,
        detail: { connectionId: 'c1', chunkIndex: 0, phase: 'ai:stream-replayed' },
      },
      {
        type: 'fetch-stream:chunk-duplicated',
        timestamp: 1100,
        applied: true,
        detail: { connectionId: 'c1', chunkIndex: 1, phase: 'ai:chunk-duplicated', mutationIndex: 0 },
      },
    ];
  }

  it('passes mutationIndex through timeline and connection entries', () => {
    const report = buildChaosReport(replayedEvents(), { now: 1 });
    expect(report.timeline[1]!.mutationIndex).toBe(0);
    expect(report.connections[0]!.entries[1]!.mutationIndex).toBe(0);
    expect(report.timeline[0]!.mutationIndex).toBeNull();
  });

  it('renders the mutation attribution in markdown output', () => {
    const md = formatReportMarkdown(buildChaosReport(replayedEvents(), { now: 1 }));
    expect(md).toContain('(mutation 0)');
  });
});
