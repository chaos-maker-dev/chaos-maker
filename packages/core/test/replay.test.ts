import { describe, it, expect } from 'vitest';
import {
  parseFixture,
  applyMutations,
  resolveReplay,
  REPLAY_FIXTURE_VERSION,
  type ReplayPlan,
} from '../src/ai/replay';
import { ChaosConfigError } from '../src/errors';
import type { ReplayFixture, ReplayMutation } from '../src/config';

const decoder = new TextDecoder();

function fixture(overrides: Partial<ReplayFixture> = {}): ReplayFixture {
  return {
    version: 1,
    transport: 'fetch-stream',
    chunks: [
      { offsetMs: 0, data: 'AA' },
      { offsetMs: 100, data: 'BB' },
      { offsetMs: 200, data: 'CC' },
      { offsetMs: 300, data: 'DD' },
    ],
    ...overrides,
  };
}

/** Snapshot-friendly projection: decode bytes so tests read as text, and keep
 *  the byte array so we still assert the encoded form. */
function simplify(plan: ReplayPlan) {
  return {
    truncated: plan.truncated,
    pieces: plan.pieces.map((p) => ({
      text: p.text,
      decoded: decoder.decode(p.bytes),
      bytes: Array.from(p.bytes),
      emitAtMs: p.emitAtMs,
      sourceIndex: p.sourceIndex,
      kind: p.kind,
      pauseBeforeMs: p.pauseBeforeMs,
    })),
  };
}

describe('parseFixture', () => {
  it('accepts a valid v1 fixture and strips unknown top-level keys', () => {
    const parsed = parseFixture({
      version: 1,
      transport: 'sse',
      url: 'https://api.example.com/chat',
      capturedAt: '2026-05-28T10:00:00Z',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      contentType: 'text/event-stream',
      chunks: [{ offsetMs: 0, data: 'x' }],
      somethingUnknown: true,
    });
    expect(parsed.version).toBe(REPLAY_FIXTURE_VERSION);
    expect(parsed.transport).toBe('sse');
    expect(parsed.chunks).toHaveLength(1);
    expect((parsed as Record<string, unknown>).somethingUnknown).toBeUndefined();
  });

  it('rejects a fixture with no version, referencing the upgrade path', () => {
    let err: ChaosConfigError | undefined;
    try {
      parseFixture({ transport: 'fetch-stream', chunks: [] });
    } catch (e) {
      err = e as ChaosConfigError;
    }
    expect(err).toBeInstanceOf(ChaosConfigError);
    expect(err!.issues[0].code).toBe('unknown_schema_version');
    expect(err!.message).toMatch(/version/i);
    expect(err!.message).toMatch(/docs/i);
  });

  it('rejects an unknown major version', () => {
    let err: ChaosConfigError | undefined;
    try {
      parseFixture({ version: 2, transport: 'fetch-stream', chunks: [] });
    } catch (e) {
      err = e as ChaosConfigError;
    }
    expect(err).toBeInstanceOf(ChaosConfigError);
    expect(err!.issues[0].code).toBe('unknown_schema_version');
    expect(err!.issues[0].received).toBe('2');
  });

  it('rejects an unknown transport', () => {
    expect(() => parseFixture({ version: 1, transport: 'grpc', chunks: [] })).toThrow(ChaosConfigError);
  });

  it('rejects non-string chunk data and negative offsets', () => {
    expect(() => parseFixture({ version: 1, transport: 'fetch-stream', chunks: [{ offsetMs: 0, data: 5 }] })).toThrow(
      /`data` must be a string/,
    );
    expect(() =>
      parseFixture({ version: 1, transport: 'fetch-stream', chunks: [{ offsetMs: -1, data: 'x' }] }),
    ).toThrow(/`offsetMs`/);
  });
});

describe('applyMutations - baseline', () => {
  it('emits one piece per chunk with no mutations', () => {
    const plan = applyMutations(fixture());
    expect(plan.truncated).toBe(false);
    expect(plan.pieces.map((p) => p.text)).toEqual(['AA', 'BB', 'CC', 'DD']);
    expect(plan.pieces.map((p) => p.emitAtMs)).toEqual([0, 100, 200, 300]);
    expect(plan.pieces.every((p) => p.kind === 'original')).toBe(true);
    expect(plan.pieces[0].sourceIndex).toBe(0);
    expect(decoder.decode(plan.pieces[1].bytes)).toBe('BB');
  });
});

describe('applyMutations - individual mutations', () => {
  it('truncate drops every chunk after N and flags truncated', () => {
    const plan = applyMutations(fixture(), [{ type: 'truncate', afterChunk: 1 }]);
    expect(plan.truncated).toBe(true);
    expect(plan.pieces.map((p) => p.text)).toEqual(['AA', 'BB']);
  });

  it('duplicate emits chunk N a second time tagged as duplicate', () => {
    const plan = applyMutations(fixture(), [{ type: 'duplicate', chunkIndex: 1 }]);
    expect(plan.pieces.map((p) => `${p.sourceIndex}:${p.kind}:${p.text}`)).toEqual([
      '0:original:AA',
      '1:original:BB',
      '1:duplicate:BB',
      '2:original:CC',
      '3:original:DD',
    ]);
  });

  it('split breaks chunk N at the character offset into head + tail', () => {
    const plan = applyMutations(fixture({ chunks: [{ offsetMs: 0, data: 'hello' }] }), [
      { type: 'split', chunkIndex: 0, at: 2 },
    ]);
    expect(plan.pieces.map((p) => [p.kind, p.text])).toEqual([
      ['split-head', 'he'],
      ['split-tail', 'llo'],
    ]);
    expect(plan.pieces.every((p) => p.emitAtMs === 0 && p.sourceIndex === 0)).toBe(true);
  });

  it('coalesce merges a run of chunks into one and drops the merged-away chunks', () => {
    const plan = applyMutations(fixture(), [{ type: 'coalesce', startChunk: 1, count: 2 }]);
    expect(plan.pieces.map((p) => `${p.sourceIndex}:${p.kind}:${p.text}`)).toEqual([
      '0:original:AA',
      '1:coalesce:BBCC',
      '3:original:DD',
    ]);
    // merged piece keeps the first chunk's offset
    expect(plan.pieces[1].emitAtMs).toBe(100);
  });

  it('inject-malformed inserts a new chunk after N with sourceIndex -1', () => {
    const plan = applyMutations(fixture(), [{ type: 'inject-malformed', afterChunk: 0, payload: '{"broken' }]);
    expect(plan.pieces.slice(0, 2).map((p) => `${p.sourceIndex}:${p.kind}:${p.text}`)).toEqual([
      '0:original:AA',
      '-1:inject-malformed:{"broken',
    ]);
  });

  it('delay shifts later chunks by ms and marks the pause boundary', () => {
    const plan = applyMutations(fixture(), [{ type: 'delay', afterChunk: 1, ms: 2000 }]);
    expect(plan.pieces.map((p) => p.emitAtMs)).toEqual([0, 100, 2200, 2300]);
    // chunk 2 is the first after the pause boundary
    expect(plan.pieces[2].pauseBeforeMs).toBe(2000);
    expect(plan.pieces[0].pauseBeforeMs).toBeUndefined();
  });
});

describe('applyMutations - determinism + composition', () => {
  const mutations: ReplayMutation[] = [
    { type: 'duplicate', chunkIndex: 2 },
    { type: 'delay', afterChunk: 0, ms: 500 },
    { type: 'split', chunkIndex: 1, at: 1 },
    { type: 'inject-malformed', afterChunk: 2, payload: 'X' },
  ];

  it('produces byte-identical, timing-identical plans across runs', () => {
    const a = simplify(applyMutations(fixture(), mutations));
    const b = simplify(applyMutations(fixture(), mutations));
    expect(a).toEqual(b);
  });

  it('is stable regardless of input array order for non-conflicting mutations', () => {
    const forward = simplify(applyMutations(fixture(), mutations));
    const reversed = simplify(applyMutations(fixture(), [...mutations].reverse()));
    expect(forward).toEqual(reversed);
  });

  it('applies conflicting mutations on the same index in array order', () => {
    const splitThenCoalesce = applyMutations(fixture(), [
      { type: 'split', chunkIndex: 1, at: 1 },
      { type: 'coalesce', startChunk: 1, count: 2 },
    ]);
    // split makes chunk 1 = ['B','B']; coalesce then merges 1..2 => 'BBCC'
    expect(splitThenCoalesce.pieces.map((p) => `${p.kind}:${p.text}`)).toEqual([
      'original:AA',
      'coalesce:BBCC',
      'original:DD',
    ]);
  });

  it('ignores out-of-range mutation indices without throwing', () => {
    const plan = applyMutations(fixture(), [
      { type: 'duplicate', chunkIndex: 99 },
      { type: 'truncate', afterChunk: 99 },
    ]);
    expect(plan.truncated).toBe(false);
    expect(plan.pieces.map((p) => p.text)).toEqual(['AA', 'BB', 'CC', 'DD']);
  });
});

describe('resolveReplay', () => {
  it('validates then resolves in one call', () => {
    const plan = resolveReplay(fixture(), [{ type: 'truncate', afterChunk: 0 }]);
    expect(plan.truncated).toBe(true);
    expect(plan.pieces.map((p) => p.text)).toEqual(['AA']);
  });

  it('throws ChaosConfigError from the validation step', () => {
    expect(() => resolveReplay({ transport: 'fetch-stream', chunks: [] })).toThrow(ChaosConfigError);
  });
});
