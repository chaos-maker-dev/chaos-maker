/**
 * Chunk stream replay engine (pure).
 *
 * Turns a captured stream fixture plus an optional list of deterministic
 * mutations into an ordered emission plan. This module is intentionally free
 * of timers, emitters, and interceptor coupling: it is a pure function of
 * `(fixture, mutations)` so the interceptors can drive emission (timing +
 * events) on top of a stable, snapshot-testable plan.
 *
 * Determinism contract:
 *   - Every mutation addresses ORIGINAL fixture chunk indices, never
 *     running/shifted indices.
 *   - Mutations are applied in a stable order: sorted by target index, then by
 *     their position in the input array. Conflicting mutations on the same
 *     index compose in array order.
 *   - No RNG anywhere. The same `(fixture, mutations)` always yields identical
 *     bytes and timing regardless of seed.
 *
 * Vocabulary: `chunk` only. `token` never appears on this surface.
 */

import type { ReplayChunk, ReplayFixture, ReplayMutation } from '../config';
import { ChaosConfigError } from '../errors';
import type { ValidationIssue } from '../validation-types';

/** The only fixture format version this build understands. */
export const REPLAY_FIXTURE_VERSION = 1 as const;

const VALID_TRANSPORTS: ReadonlyArray<ReplayFixture['transport']> = [
  'fetch-stream',
  'sse',
  'websocket',
];

/** What produced an emitted piece. Interceptors map `kind` to the concrete
 *  chaos event + streaming `phase` they emit. */
export type ReplayPieceKind =
  | 'original'
  | 'split-head'
  | 'split-tail'
  | 'coalesce'
  | 'duplicate'
  | 'inject-malformed';

/** One unit the replay driver enqueues onto the synthetic stream. */
export interface ReplayPiece {
  /** UTF-8 encoded bytes to enqueue. */
  bytes: Uint8Array;
  /** Decoded text (same content as `bytes`); kept for diagnostics + tests. */
  text: string;
  /** Absolute emit time (ms from stream start), including delay shifts. */
  emitAtMs: number;
  /** Original fixture chunk index this piece derives from; `-1` when injected
   *  by an `inject-malformed` mutation. */
  sourceIndex: number;
  /** Provenance of this piece. */
  kind: ReplayPieceKind;
  /** Set on the first piece of the chunk immediately following a `delay`
   *  mutation. The driver emits `ai:stream-paused` / `ai:stream-resumed` around
   *  the gap. Timing is already baked into `emitAtMs`; this field only drives
   *  the lifecycle events. */
  pauseBeforeMs?: number;
}

/** Ordered emission plan produced by {@link applyMutations}. */
export interface ReplayPlan {
  pieces: ReplayPiece[];
  /** True when a `truncate` mutation dropped the tail of the stream, so the
   *  driver emits `ai:stream-truncated` after the final piece. */
  truncated: boolean;
}

/** Build a validation issue for a fixture problem, tagged to the `ai` rule
 *  type so it sorts and renders alongside other config errors. */
function issue(path: string, message: string, extra: Partial<ValidationIssue> = {}): ValidationIssue {
  return { path, code: 'custom', ruleType: 'ai', message, ...extra };
}

/**
 * Validate + normalize a raw replay fixture. Throws `ChaosConfigError` on a
 * missing/unknown version or a structurally invalid fixture. The version error
 * points at the stream replay docs so users know the upgrade path.
 */
export function parseFixture(raw: unknown): ReplayFixture {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ChaosConfigError([issue('ai.replay.data', 'replay fixture must be an object')]);
  }
  const f = raw as Record<string, unknown>;

  if (f.version === undefined) {
    throw new ChaosConfigError([
      issue(
        'ai.replay.data.version',
        'replay fixture is missing the required `version` field; add `"version": 1`. See the stream replay concept docs for the fixture format.',
        { code: 'unknown_schema_version', expected: '1' },
      ),
    ]);
  }
  if (f.version !== REPLAY_FIXTURE_VERSION) {
    throw new ChaosConfigError([
      issue(
        'ai.replay.data.version',
        `unsupported replay fixture version ${JSON.stringify(f.version)}; this build understands version ${REPLAY_FIXTURE_VERSION}. See the stream replay concept docs for the fixture upgrade path.`,
        { code: 'unknown_schema_version', expected: String(REPLAY_FIXTURE_VERSION), received: JSON.stringify(f.version) },
      ),
    ]);
  }

  if (typeof f.transport !== 'string' || !VALID_TRANSPORTS.includes(f.transport as ReplayFixture['transport'])) {
    throw new ChaosConfigError([
      issue('ai.replay.data.transport', `replay fixture \`transport\` must be one of ${VALID_TRANSPORTS.map((t) => `'${t}'`).join(' | ')}`, {
        expected: VALID_TRANSPORTS.map((t) => `'${t}'`).join(' | '),
        received: JSON.stringify(f.transport),
      }),
    ]);
  }

  if (!Array.isArray(f.chunks)) {
    throw new ChaosConfigError([issue('ai.replay.data.chunks', 'replay fixture `chunks` must be an array')]);
  }

  let previousOffsetMs = -Infinity;
  const chunks: ReplayChunk[] = f.chunks.map((c, i) => {
    if (typeof c !== 'object' || c === null) {
      throw new ChaosConfigError([issue(`ai.replay.data.chunks[${i}]`, 'each replay chunk must be an object')]);
    }
    const chunk = c as Record<string, unknown>;
    if (typeof chunk.data !== 'string') {
      throw new ChaosConfigError([
        issue(`ai.replay.data.chunks[${i}].data`, 'replay chunk `data` must be a string (text streams only in this release)'),
      ]);
    }
    if (typeof chunk.offsetMs !== 'number' || !Number.isFinite(chunk.offsetMs) || chunk.offsetMs < 0) {
      throw new ChaosConfigError([
        issue(`ai.replay.data.chunks[${i}].offsetMs`, 'replay chunk `offsetMs` must be a finite number >= 0'),
      ]);
    }
    // `offsetMs` is an absolute time from stream start and array order is
    // emission order, so the offsets must be non-decreasing; otherwise the plan
    // would emit pieces whose `emitAtMs` runs backwards.
    if (chunk.offsetMs < previousOffsetMs) {
      throw new ChaosConfigError([
        issue(
          `ai.replay.data.chunks[${i}].offsetMs`,
          'replay chunk `offsetMs` must be >= the previous chunk offset (chunks are ordered by stream time)',
        ),
      ]);
    }
    previousOffsetMs = chunk.offsetMs;
    return { offsetMs: chunk.offsetMs, data: chunk.data };
  });

  const normalized: ReplayFixture = {
    version: REPLAY_FIXTURE_VERSION,
    transport: f.transport as ReplayFixture['transport'],
    chunks,
  };
  if (typeof f.url === 'string') normalized.url = f.url;
  if (typeof f.capturedAt === 'string') normalized.capturedAt = f.capturedAt;
  if (typeof f.status === 'number') normalized.status = f.status;
  if (f.headers && typeof f.headers === 'object') normalized.headers = { ...(f.headers as Record<string, string>) };
  if (typeof f.contentType === 'string') normalized.contentType = f.contentType;
  return normalized;
}

/** The original fixture index a mutation targets, used for the stable sort. */
function mutationTargetIndex(m: ReplayMutation): number {
  switch (m.type) {
    case 'coalesce':
      return m.startChunk;
    case 'duplicate':
    case 'split':
      return m.chunkIndex;
    case 'delay':
    case 'truncate':
    case 'inject-malformed':
      return m.afterChunk;
  }
}

/** A post-content operation on a segment, recorded in the order its mutation
 *  appeared in the input array so same-target mutations compose deterministically
 *  and repeat correctly. `duplicate` re-emits the chunk's content; `inject`
 *  emits a synthetic malformed chunk after it. */
type SegmentOp = { kind: 'duplicate' } | { kind: 'inject'; payload: string };

/** Working state for one original fixture chunk while mutations fold in.
 *  `content` holds the chunk's own text pieces (rewritten by `split` /
 *  `coalesce`); `postOps` holds `duplicate` / `inject-malformed` operations in
 *  input-array order. */
interface Segment {
  baseOffsetMs: number;
  /** Removed because an earlier chunk coalesced this one away. */
  dropped: boolean;
  /** The chunk's own content pieces; a single `original` piece until `split`
   *  or `coalesce` rewrites it. */
  content: { text: string; kind: ReplayPieceKind }[];
  /** Post-content operations, in the order their mutations appeared. */
  postOps: SegmentOp[];
}

/** Encode one text piece into an emitted plan piece. */
function makePiece(
  text: string,
  emitAtMs: number,
  sourceIndex: number,
  kind: ReplayPieceKind,
  encoder: TextEncoder,
): ReplayPiece {
  return { bytes: encoder.encode(text), text, emitAtMs, sourceIndex, kind };
}

/**
 * Fold a fixture + mutations into an ordered emission plan. Pure and
 * deterministic; see the module docstring for the determinism contract.
 */
export function applyMutations(fixture: ReplayFixture, mutations: ReplayMutation[] = []): ReplayPlan {
  const encoder = new TextEncoder();
  const n = fixture.chunks.length;

  const segs: Segment[] = fixture.chunks.map((c) => ({
    baseOffsetMs: c.offsetMs,
    dropped: false,
    content: [{ text: c.data, kind: 'original' }],
    postOps: [],
  }));

  const ordered = mutations
    .map((m, i) => ({ m, i }))
    .sort((a, b) => mutationTargetIndex(a.m) - mutationTargetIndex(b.m) || a.i - b.i);

  // delay: afterChunk N shifts every chunk with index > N by `ms`.
  const delays: { after: number; ms: number }[] = [];
  let truncateAfter = Infinity;

  // Only integer, in-bounds indices are valid; non-integers (e.g. 1.5) are
  // ignored rather than allowed to index `segs` and read `undefined`.
  const inRange = (idx: number): boolean => Number.isInteger(idx) && idx >= 0 && idx < n;

  for (const { m } of ordered) {
    switch (m.type) {
      case 'split': {
        if (!inRange(m.chunkIndex)) break;
        const seg = segs[m.chunkIndex];
        // `at` is a character offset. Split on code points (via the string
        // iterator) so a cut inside a surrogate pair cannot produce lone
        // surrogates that `TextEncoder` would turn into replacement bytes.
        const codePoints = Array.from(seg.content.map((p) => p.text).join(''));
        const at = Math.max(0, Math.min(m.at, codePoints.length));
        seg.content = [
          { text: codePoints.slice(0, at).join(''), kind: 'split-head' },
          { text: codePoints.slice(at).join(''), kind: 'split-tail' },
        ];
        break;
      }
      case 'coalesce': {
        if (!inRange(m.startChunk) || m.count <= 0) break;
        const end = Math.min(m.startChunk + m.count, n);
        const target = segs[m.startChunk];
        let merged = target.content.map((p) => p.text).join('');
        for (let i = m.startChunk + 1; i < end; i++) {
          merged += segs[i].content.map((p) => p.text).join('');
          segs[i].dropped = true;
        }
        target.content = [{ text: merged, kind: 'coalesce' }];
        break;
      }
      case 'duplicate': {
        if (inRange(m.chunkIndex)) segs[m.chunkIndex].postOps.push({ kind: 'duplicate' });
        break;
      }
      case 'inject-malformed': {
        if (inRange(m.afterChunk)) segs[m.afterChunk].postOps.push({ kind: 'inject', payload: m.payload });
        break;
      }
      case 'delay': {
        if (inRange(m.afterChunk)) delays.push({ after: m.afterChunk, ms: m.ms });
        break;
      }
      case 'truncate': {
        if (inRange(m.afterChunk)) truncateAfter = Math.min(truncateAfter, m.afterChunk);
        break;
      }
    }
  }

  const pieces: ReplayPiece[] = [];
  let truncated = false;

  for (let idx = 0; idx < n; idx++) {
    if (idx > truncateAfter) {
      truncated = true;
      break;
    }
    const seg = segs[idx];
    if (seg.dropped) continue;

    const shift = delays.reduce((acc, d) => acc + (idx > d.after ? d.ms : 0), 0);
    const pauseBeforeMs = delays.reduce((acc, d) => acc + (d.after === idx - 1 ? d.ms : 0), 0);
    const emitAt = seg.baseOffsetMs + shift;

    let firstOfChunk = true;
    for (const p of seg.content) {
      const piece = makePiece(p.text, emitAt, idx, p.kind, encoder);
      if (firstOfChunk && pauseBeforeMs > 0) {
        piece.pauseBeforeMs = pauseBeforeMs;
      }
      firstOfChunk = false;
      pieces.push(piece);
    }

    // Post-content operations emit in input-array order, so repeated
    // duplicates each add an emission and duplicate/inject interleave as
    // written.
    for (const op of seg.postOps) {
      if (op.kind === 'duplicate') {
        for (const p of seg.content) {
          pieces.push(makePiece(p.text, emitAt, idx, 'duplicate', encoder));
        }
      } else {
        pieces.push(makePiece(op.payload, emitAt, -1, 'inject-malformed', encoder));
      }
    }
  }

  return { pieces, truncated };
}

/**
 * Validate a raw fixture and resolve it to an emission plan in one call. The
 * interceptors use this at stream-substitution time; `parseFixture` +
 * `applyMutations` are exposed separately for unit testing and for callers that
 * already hold a validated fixture.
 */
export function resolveReplay(rawFixture: unknown, mutations: ReplayMutation[] = []): ReplayPlan {
  return applyMutations(parseFixture(rawFixture), mutations);
}
