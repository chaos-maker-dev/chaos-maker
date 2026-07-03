/**
 * fetch-stream chaos interceptor.
 *
 * Two cooperating hooks:
 *
 *   1. **Primary hook: `Response.prototype.body` getter patch.** Wraps every
 *      access to a response body so chaos applies even when an SDK
 *      (Vercel AI SDK, OpenAI SDK, LangChain) grabs the stream before the
 *      user code sees the `Response`. This is the only hook that catches
 *      those wrappers reliably.
 *
 *   2. **Fetch-side request hook: `fetch` wrapper.** Tags each in-flight
 *      `Response` with chaos metadata (matched rules, parsed URL, connection
 *      id) BEFORE returning. The body-getter looks up that tag via a
 *      `WeakMap` and decides whether to wrap the stream. Without this tag,
 *      the body-getter would have to re-run matchers on every getter access.
 *
 * Idempotent body getter: the wrapped chaos stream is built once on the first
 * `.body` access and the same reference is returned on every subsequent
 * access, matching the native `Response.body` (which returns a stable stream
 * reference). This is what makes the common defensive pattern
 * `if (!response.body) return; response.body.getReader()` apply chaos: the
 * truthy check and the read observe the same wrapped stream rather than the
 * check burning a one-shot chaos branch and the read getting clean data.
 *
 * Per-chunk pipeline (executed inside a `TransformStream`):
 *   close-after-chunk → drop → corrupt (incl. duplicate) → delay → enqueue
 *
 * A drop short-circuits the rest. The `duplicate` corruption strategy
 * enqueues the chunk one additional time after the regular enqueue.
 *
 * On `uninstall()`: pending delay timers are cleared and any active
 * `TransformStream` controllers are terminated; pending close timers are
 * cancelled. The patched body getter is restored to the captured original.
 */

import {
  FetchStreamConfig,
  FetchStreamDropConfig,
  FetchStreamDelayConfig,
  FetchStreamCorruptConfig,
  FetchStreamCloseConfig,
  FetchStreamCorruptionStrategy,
  FetchStreamReplayConfig,
  RequestCountingOptions,
  HostnameMatcher,
  RequestKvMatcher,
} from '../config';
import { resolveReplay, type ReplayPlan } from '../ai/replay';
import { ChaosEventEmitter, type ChaosPhase } from '../events';
import {
  shouldApplyChaos,
  matchUrl,
  incrementCounter,
  checkCountingCondition,
  gateGroup,
} from '../utils';
import {
  parseRequestUrl,
  matchHostname,
  matchChunkText,
  matchQueryParams,
  type ParsedRequestUrl,
} from '../matchers';
import type { RuleGroupRegistry } from '../groups';
import type { CancelableStreamConnection, StreamCancelRegistry } from './streamCancelRegistry';

const RESPONSE_META = new WeakMap<Response, ResponseChaosMeta>();
const BODY_GETTER_PATCH_MARKER = Symbol.for('chaos-maker.fetch-stream.body-getter');

interface ResponseChaosMeta {
  url: string;
  connectionId: string;
  parsedUrl: ParsedRequestUrl | null;
  /** Per-response wrapped body, built lazily on first `.body` access and
   *  returned on every subsequent access so the getter is idempotent. Mirrors
   *  the native `Response.body`, which returns a stable stream reference; this
   *  is what lets a defensive `if (!r.body) ...; r.body.getReader()` apply
   *  chaos instead of consuming a one-shot branch on the truthy check. */
  wrappedBody?: ReadableStream<Uint8Array>;
  /** When set, this response is served from a replay fixture: the body getter
   *  returns a synthetic stream built from this plan and discards the native
   *  body. Set only in substitute mode (`blockUpstream: false`); block mode
   *  never creates a `RESPONSE_META` entry because it owns the whole Response. */
  replayPlan?: ReplayPlan;
}

interface TransportRuleLike {
  urlPattern?: string;
  hostname?: HostnameMatcher;
  queryParams?: Record<string, RequestKvMatcher>;
}

export interface FetchStreamPatchHandle {
  /** Wrapped `fetch` suitable for `globalThis.fetch = …`. */
  readonly fetch: typeof fetch;
  /** Restore the body getter + cancel pending timers + terminate active
   *  controllers. Call from `ChaosMaker.stop()`. */
  uninstall(): void;
}

/** Minimal cross-realm `Response` constructor surface used by
 *  `patchFetchStream`. Any constructor whose `prototype` carries a
 *  `body` accessor matches; the iframe-realm `Response` shipped by the
 *  consumer browser satisfies this without further structural typing. */
export type ResponseCtorLike = {
  prototype: { body: ReadableStream<Uint8Array> | null };
};

interface GateResult {
  proceed: boolean;
  matchedBy?: string[];
  skippedAt?: string;
}

function gateTransportRule(
  rule: TransportRuleLike,
  url: string,
  getParsedUrl: () => ParsedRequestUrl | null,
): GateResult {
  if (!matchUrl(url, rule.urlPattern)) return { proceed: false, skippedAt: 'urlPattern' };
  const matchedBy: string[] = [];
  if (rule.hostname !== undefined) {
    const parsed = getParsedUrl();
    if (!parsed || !matchHostname(parsed.hostname, rule.hostname)) {
      return { proceed: false, skippedAt: 'hostname' };
    }
    matchedBy.push('hostname');
  }
  if (rule.queryParams) {
    const parsed = getParsedUrl();
    if (!parsed || !matchQueryParams(parsed.searchParams, rule.queryParams)) {
      return { proceed: false, skippedAt: 'queryParams' };
    }
    matchedBy.push('queryParams');
  }
  return { proceed: true, matchedBy: matchedBy.length > 0 ? matchedBy : undefined };
}

type ChunkGatedRule = RequestCountingOptions &
  TransportRuleLike & {
    chunkIndex?: number;
    chunkPattern?: string | RegExp;
    probability: number;
    group?: string;
  };

function findFiringChunkRule<T extends ChunkGatedRule>(
  rules: T[] | undefined,
  meta: ResponseChaosMeta,
  chunkIndex: number,
  random: () => number,
  counters: Map<object, number>,
  groups: RuleGroupRegistry | undefined,
  emitter: ChaosEventEmitter,
  /** Lazy decoded UTF-8 text of the current chunk; `null` when the chunk is
   *  not valid UTF-8. Only consulted for rules that set `chunkPattern`. */
  getChunkText?: () => string | null,
  /** Invoked when a rule with `chunkPattern` skips a binary chunk, so the
   *  caller can surface a once-per-connection diagnostic. */
  onBinaryPatternSkip?: (rule: object) => void,
): T | null {
  if (!rules) return null;
  const getParsedUrl = (): ParsedRequestUrl | null => meta.parsedUrl;
  const baseDetail = { url: meta.url, chunkIndex, connectionId: meta.connectionId };
  for (const rule of rules) {
    emitter.debug('rule-evaluating', baseDetail, rule as object);
    if (rule.chunkIndex !== undefined && rule.chunkIndex !== chunkIndex) {
      emitter.debug('rule-skip-match', { ...baseDetail, skippedAt: 'chunkIndex' }, rule as object);
      continue;
    }
    if (rule.chunkPattern !== undefined) {
      const text = getChunkText ? getChunkText() : null;
      if (text === null) {
        emitter.debug('rule-skip-match', { ...baseDetail, skippedAt: 'chunkPattern-binary' }, rule as object);
        if (onBinaryPatternSkip) onBinaryPatternSkip(rule as object);
        continue;
      }
      if (!matchChunkText(text, rule.chunkPattern)) {
        emitter.debug('rule-skip-match', { ...baseDetail, skippedAt: 'chunkPattern' }, rule as object);
        continue;
      }
    }
    const gate = gateTransportRule(rule, meta.url, getParsedUrl);
    if (!gate.proceed) {
      emitter.debug('rule-skip-match', { ...baseDetail, skippedAt: gate.skippedAt }, rule as object);
      continue;
    }
    emitter.debug('rule-matched', { ...baseDetail, matchedBy: gate.matchedBy }, rule as object);
    const count = incrementCounter(rule, counters);
    if (!checkCountingCondition(rule, count)) {
      emitter.debug('rule-skip-counting', baseDetail, rule as object);
      continue;
    }
    if (!gateGroup(rule, groups, emitter, baseDetail)) continue;
    if (!shouldApplyChaos(rule.probability, random)) {
      emitter.debug('rule-skip-probability', baseDetail, rule as object);
      continue;
    }
    emitter.debug('rule-applied', baseDetail, rule as object);
    return rule;
  }
  return null;
}

type CloseGatedRule = RequestCountingOptions &
  TransportRuleLike & {
    afterMs?: number;
    afterChunk?: number;
    probability: number;
    group?: string;
  };

function findFiringCloseRule(
  rules: FetchStreamCloseConfig[] | undefined,
  meta: ResponseChaosMeta,
  random: () => number,
  counters: Map<object, number>,
  groups: RuleGroupRegistry | undefined,
  emitter: ChaosEventEmitter,
): CloseGatedRule | null {
  if (!rules) return null;
  const getParsedUrl = (): ParsedRequestUrl | null => meta.parsedUrl;
  const baseDetail = { url: meta.url, connectionId: meta.connectionId };
  for (const rule of rules as CloseGatedRule[]) {
    emitter.debug('rule-evaluating', baseDetail, rule as object);
    const gate = gateTransportRule(rule, meta.url, getParsedUrl);
    if (!gate.proceed) {
      emitter.debug('rule-skip-match', { ...baseDetail, skippedAt: gate.skippedAt }, rule as object);
      continue;
    }
    emitter.debug('rule-matched', { ...baseDetail, matchedBy: gate.matchedBy }, rule as object);
    const count = incrementCounter(rule, counters);
    if (!checkCountingCondition(rule, count)) {
      emitter.debug('rule-skip-counting', baseDetail, rule as object);
      continue;
    }
    if (!gateGroup(rule, groups, emitter, baseDetail)) continue;
    if (!shouldApplyChaos(rule.probability, random)) {
      emitter.debug('rule-skip-probability', baseDetail, rule as object);
      continue;
    }
    emitter.debug('rule-applied', baseDetail, rule as object);
    return rule;
  }
  return null;
}

function emitDrop(emitter: ChaosEventEmitter, meta: ResponseChaosMeta, chunkIndex: number, bytes: number): void {
  emitter.emit({
    type: 'fetch-stream:chunk-dropped',
    timestamp: Date.now(),
    applied: true,
    detail: { url: meta.url, connectionId: meta.connectionId, chunkIndex, chunkBytes: bytes },
  });
}

function emitDelay(
  emitter: ChaosEventEmitter,
  meta: ResponseChaosMeta,
  chunkIndex: number,
  delayMs: number,
  bytes: number,
  mutationIndex?: number,
): void {
  emitter.emit({
    type: 'fetch-stream:chunk-delayed',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: meta.url,
      connectionId: meta.connectionId,
      chunkIndex,
      delayMs,
      chunkBytes: bytes,
      phase: 'ai:stream-paused',
      ...(mutationIndex !== undefined ? { mutationIndex } : {}),
    },
  });
}

function emitCorrupt(
  emitter: ChaosEventEmitter,
  meta: ResponseChaosMeta,
  chunkIndex: number,
  strategy: FetchStreamCorruptionStrategy,
  bytes: number,
  phase?: ChaosPhase,
): void {
  emitter.emit({
    type: 'fetch-stream:chunk-corrupted',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: meta.url,
      connectionId: meta.connectionId,
      chunkIndex,
      strategy,
      chunkBytes: bytes,
      ...(phase !== undefined ? { phase } : {}),
    },
  });
}

function emitDuplicate(
  emitter: ChaosEventEmitter,
  meta: ResponseChaosMeta,
  chunkIndex: number,
  bytes: number,
  mutationIndex?: number,
): void {
  emitter.emit({
    type: 'fetch-stream:chunk-duplicated',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: meta.url,
      connectionId: meta.connectionId,
      chunkIndex,
      chunkBytes: bytes,
      phase: 'ai:chunk-duplicated',
      ...(mutationIndex !== undefined ? { mutationIndex } : {}),
    },
  });
}

function emitTruncate(
  emitter: ChaosEventEmitter,
  meta: ResponseChaosMeta,
  reason: string,
  chunkIndex: number,
  mutationIndex?: number,
): void {
  emitter.emit({
    type: 'fetch-stream:truncated',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: meta.url,
      connectionId: meta.connectionId,
      chunkIndex,
      reason,
      phase: 'ai:stream-truncated',
      ...(mutationIndex !== undefined ? { mutationIndex } : {}),
    },
  });
}

function emitFirstChunkMarker(emitter: ChaosEventEmitter, meta: ResponseChaosMeta): void {
  emitter.emit({
    type: 'fetch-stream:lifecycle',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: meta.url,
      connectionId: meta.connectionId,
      chunkIndex: 0,
      phase: 'ai:first-chunk',
    },
  });
}

function emitStreamResumedMarker(emitter: ChaosEventEmitter, meta: ResponseChaosMeta, chunkIndex: number): void {
  emitter.emit({
    type: 'fetch-stream:lifecycle',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: meta.url,
      connectionId: meta.connectionId,
      chunkIndex,
      phase: 'ai:stream-resumed',
    },
  });
}

function emitReplayStarted(emitter: ChaosEventEmitter, meta: ResponseChaosMeta): void {
  emitter.emit({
    type: 'fetch-stream:lifecycle',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: meta.url,
      connectionId: meta.connectionId,
      chunkIndex: 0,
      phase: 'ai:stream-replayed',
    },
  });
}

function mutateChunkText(
  chunk: Uint8Array,
  strategy: FetchStreamCorruptionStrategy,
  preDecoded?: string | null,
): { out: Uint8Array; binarySkip: boolean } {
  if (strategy === 'duplicate') {
    // Emission-level; caller enqueues twice. No text mutation.
    return { out: chunk, binarySkip: false };
  }
  // `fatal: true` makes `decode()` throw `TypeError` on malformed UTF-8 so
  // binary chunks (or partial multi-byte sequences) are caught and skipped
  // rather than silently mutated. NOTE: this is a per-chunk decoder, so a
  // valid multi-byte code point split across chunk boundaries can be
  // misclassified as binary. Streaming chaos consumers that need byte-perfect
  // text reassembly should reach for fetch-stream directly with their own
  // decoder rather than the corruption strategies below.
  // `preDecoded` reuses the chunkPattern gate's decode of the same bytes:
  // a string skips the decode, `null` means that decode already failed.
  let text: string;
  if (preDecoded !== undefined) {
    if (preDecoded === null) {
      return { out: chunk, binarySkip: true };
    }
    text = preDecoded;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(chunk);
    } catch {
      return { out: chunk, binarySkip: true };
    }
  }
  let mutated: string;
  switch (strategy) {
    case 'truncate':
      mutated = text.slice(0, Math.max(0, Math.floor(text.length / 2)));
      break;
    case 'malformed-json':
      mutated = `${text}"}`;
      break;
    case 'empty':
      mutated = '';
      break;
    case 'wrong-type':
      mutated = '<html><body>Unexpected HTML</body></html>';
      break;
  }
  return { out: new TextEncoder().encode(mutated), binarySkip: false };
}

let _connectionCounter = 0;
function mintConnectionId(): string {
  const c = (typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined);
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // fall through to counter
    }
  }
  _connectionCounter += 1;
  return `chaos-conn-${_connectionCounter}`;
}

interface ConfigMatchResult {
  matched: boolean;
}

function urlMatchesAnyRule(config: FetchStreamConfig, url: string, parsedUrl: ParsedRequestUrl | null): ConfigMatchResult {
  const lazyParsed = () => parsedUrl;
  const check = (rules: TransportRuleLike[] | undefined): boolean => {
    if (!rules) return false;
    for (const r of rules) {
      if (gateTransportRule(r, url, lazyParsed).proceed) return true;
    }
    return false;
  };
  return {
    matched:
      check(config.drops) ||
      check(config.delays) ||
      check(config.corruptions) ||
      check(config.closes),
  };
}

function wrapChaosBranch(
  source: ReadableStream<Uint8Array>,
  meta: ResponseChaosMeta,
  config: FetchStreamConfig,
  random: () => number,
  emitter: ChaosEventEmitter,
  counters: Map<object, number>,
  groups: RuleGroupRegistry | undefined,
  lifecycle: {
    terminated: () => boolean;
    markTerminated: () => void;
    registerController: (c: TransformStreamDefaultController<Uint8Array>) => void;
    registerTimer: (handle: ReturnType<typeof setTimeout>) => void;
    unregisterTimer: (handle: ReturnType<typeof setTimeout>) => void;
  },
): ReadableStream<Uint8Array> {
  let chunkIndex = -1;
  // Rules with `chunkPattern` that hit a binary (non-UTF-8) chunk surface one
  // diagnostic per rule per connection instead of one per chunk, so binary
  // streams do not flood the event log.
  const binaryPatternWarned = new WeakSet<object>();
  const closeRule = findFiringCloseRule(config.closes, meta, random, counters, groups, emitter);
  const closeAfterChunkScheduled: number | undefined = closeRule?.afterChunk;
  const closeAfterMsScheduled: number | undefined = closeRule?.afterMs;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      lifecycle.registerController(controller);
      if (closeAfterMsScheduled !== undefined) {
        const handle = setTimeout(() => {
          lifecycle.unregisterTimer(handle);
          if (lifecycle.terminated()) return;
          lifecycle.markTerminated();
          emitTruncate(emitter, meta, 'after-ms', Math.max(chunkIndex, 0));
          try {
            controller.terminate();
          } catch {
            // already terminated
          }
        }, closeAfterMsScheduled);
        lifecycle.registerTimer(handle);
      }
    },
    async transform(chunk, controller) {
      if (lifecycle.terminated()) return;
      chunkIndex += 1;
      const bytes = chunk.byteLength;
      if (chunkIndex === 0) {
        emitFirstChunkMarker(emitter, meta);
      }

      // close-after-chunk fires once we are AT the configured index
      // (so `afterChunk: 0` truncates immediately on the first chunk).
      if (closeAfterChunkScheduled !== undefined && chunkIndex >= closeAfterChunkScheduled) {
        lifecycle.markTerminated();
        emitTruncate(emitter, meta, 'after-chunk', chunkIndex);
        try {
          controller.terminate();
        } catch {
          // already terminated
        }
        return;
      }

      const dropRule = findFiringChunkRule<FetchStreamDropConfig>(config.drops, meta, chunkIndex, random, counters, groups, emitter);
      if (dropRule) {
        emitDrop(emitter, meta, chunkIndex, bytes);
        return; // omit the chunk
      }

      let outChunk = chunk;
      let decodedText: string | null | undefined;
      const getChunkText = (): string | null => {
        if (decodedText === undefined) {
          try {
            decodedText = new TextDecoder('utf-8', { fatal: true }).decode(chunk);
          } catch {
            decodedText = null;
          }
        }
        return decodedText;
      };
      const onBinaryPatternSkip = (rule: object): void => {
        if (binaryPatternWarned.has(rule)) return;
        binaryPatternWarned.add(rule);
        emitter.emit({
          type: 'fetch-stream:chunk-corrupted',
          timestamp: Date.now(),
          applied: false,
          detail: {
            url: meta.url,
            connectionId: meta.connectionId,
            chunkIndex,
            strategy: (rule as FetchStreamCorruptConfig).strategy,
            chunkBytes: bytes,
            reason: 'binary-chunk',
          },
        });
      };
      const corruptRule = findFiringChunkRule<FetchStreamCorruptConfig>(
        config.corruptions,
        meta,
        chunkIndex,
        random,
        counters,
        groups,
        emitter,
        getChunkText,
        onBinaryPatternSkip,
      );
      let duplicate = false;
      if (corruptRule) {
        if (corruptRule.strategy === 'duplicate') {
          duplicate = true;
        } else {
          const { out, binarySkip } = mutateChunkText(chunk, corruptRule.strategy, decodedText);
          if (binarySkip) {
            // Binary chunk + text strategy: skip silently with a diagnostic event.
            emitter.emit({
              type: 'fetch-stream:chunk-corrupted',
              timestamp: Date.now(),
              applied: false,
              detail: {
                url: meta.url,
                connectionId: meta.connectionId,
                chunkIndex,
                strategy: corruptRule.strategy,
                chunkBytes: bytes,
                reason: 'binary-chunk',
              },
            });
          } else {
            outChunk = out;
            emitCorrupt(emitter, meta, chunkIndex, corruptRule.strategy, bytes, corruptRule.phase);
          }
        }
      }

      const delayRule = findFiringChunkRule<FetchStreamDelayConfig>(config.delays, meta, chunkIndex, random, counters, groups, emitter);
      if (delayRule) {
        emitDelay(emitter, meta, chunkIndex, delayRule.delayMs, bytes);
        await new Promise<void>((resolve) => {
          const handle = setTimeout(() => {
            lifecycle.unregisterTimer(handle);
            resolve();
          }, delayRule.delayMs);
          lifecycle.registerTimer(handle);
        });
        if (lifecycle.terminated()) return;
        emitStreamResumedMarker(emitter, meta, chunkIndex);
      }

      try {
        controller.enqueue(outChunk);
      } catch {
        // Controller closed mid-flight (consumer canceled, stop() fired);
        // swallow so the upstream reader still gets a clean termination.
        return;
      }

      if (duplicate) {
        try {
          controller.enqueue(outChunk);
          emitDuplicate(emitter, meta, chunkIndex, bytes);
        } catch {
          // see above
        }
      }
    },
  });
  return source.pipeThrough(transform);
}

/** Lifecycle hooks a replay stream uses to register its timers + controller so
 *  `uninstall()` can tear them down. */
interface ReplayLifecycle {
  terminated: () => boolean;
  registerController: (c: ReadableStreamDefaultController<Uint8Array>) => void;
  unregisterController: (c: ReadableStreamDefaultController<Uint8Array>) => void;
  registerTimer: (h: ReturnType<typeof setTimeout>) => void;
  unregisterTimer: (h: ReturnType<typeof setTimeout>) => void;
}

/** Constructable view of the realm's `Response` for block-mode replay, so the
 *  synthetic response is built in the same realm the getter patch targets. */
type ResponseConstructor = { new (body?: BodyInit | null, init?: ResponseInit): Response };

/**
 * Build a synthetic `ReadableStream` that emits a resolved replay plan on the
 * fixture's own `offsetMs` schedule. Emits `ai:stream-replayed` at start, the
 * first-chunk / pause / resume / duplicate / truncate lifecycle events as the
 * plan dictates, and closes after the last piece. Timers register with the
 * lifecycle so `uninstall()` cancels them; `cancel()` clears this stream's
 * pending timers when the consumer aborts.
 */
function buildReplayStream(
  plan: ReplayPlan,
  meta: ResponseChaosMeta,
  emitter: ChaosEventEmitter,
  lifecycle: ReplayLifecycle,
): ReadableStream<Uint8Array> {
  const localTimers = new Set<ReturnType<typeof setTimeout>>();
  let finished = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const lastPiece = plan.pieces[plan.pieces.length - 1];
  const lastSourceIndex = lastPiece ? lastPiece.sourceIndex : 0;
  const lastAtMs = plan.pieces.reduce((max, p) => Math.max(max, p.emitAtMs), 0);

  const schedule = (fn: () => void, atMs: number): void => {
    const handle = setTimeout(() => {
      localTimers.delete(handle);
      lifecycle.unregisterTimer(handle);
      if (finished || lifecycle.terminated()) return;
      fn();
    }, Math.max(0, atMs));
    localTimers.add(handle);
    lifecycle.registerTimer(handle);
  };

  const clearLocal = (): void => {
    for (const handle of localTimers) {
      clearTimeout(handle);
      lifecycle.unregisterTimer(handle);
    }
    localTimers.clear();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      lifecycle.registerController(controller);
      emitReplayStarted(emitter, meta);
      plan.pieces.forEach((piece, i) => {
        if (piece.pauseBeforeMs) {
          schedule(
            () =>
              emitDelay(
                emitter,
                meta,
                piece.sourceIndex,
                piece.pauseBeforeMs as number,
                piece.bytes.byteLength,
                piece.pauseMutationIndex,
              ),
            piece.emitAtMs - piece.pauseBeforeMs,
          );
        }
        schedule(() => {
          if (i === 0) emitFirstChunkMarker(emitter, meta);
          if (piece.pauseBeforeMs) emitStreamResumedMarker(emitter, meta, piece.sourceIndex);
          try {
            controller.enqueue(piece.bytes);
          } catch {
            return;
          }
          if (piece.kind === 'duplicate') {
            emitDuplicate(emitter, meta, piece.sourceIndex, piece.bytes.byteLength, piece.mutationIndex);
          }
        }, piece.emitAtMs);
      });
      schedule(() => {
        finished = true;
        if (plan.truncated) emitTruncate(emitter, meta, 'replay-truncate', lastSourceIndex, plan.truncatedBy);
        try {
          controller.close();
        } catch {
          // already closed
        }
        lifecycle.unregisterController(controller);
      }, lastAtMs);
      controllerRef = controller;
    },
    cancel() {
      finished = true;
      clearLocal();
      if (controllerRef) lifecycle.unregisterController(controllerRef);
    },
  });
}

/** Build a fully synthetic `Response` for block-mode replay: no network call,
 *  the body is the replay stream, status + headers come from the fixture. */
function buildReplayResponse(
  directive: FetchStreamReplayConfig,
  plan: ReplayPlan,
  meta: ResponseChaosMeta,
  emitter: ChaosEventEmitter,
  lifecycle: ReplayLifecycle,
  ResponseCtor: ResponseConstructor,
): Response {
  const body = buildReplayStream(plan, meta, emitter, lifecycle);
  const fixture = directive.data;
  const headers = new Headers(fixture.headers ?? {});
  if (!headers.has('content-type')) {
    headers.set('content-type', fixture.contentType ?? 'text/plain; charset=utf-8');
  }
  return new ResponseCtor(body, { status: fixture.status ?? 200, headers });
}

export function patchFetchStream(
  originalFetch: typeof fetch,
  config: FetchStreamConfig,
  random: () => number,
  emitter: ChaosEventEmitter,
  counters: Map<object, number>,
  groups?: RuleGroupRegistry,
  /** Realm-specific `Response` constructor whose prototype carries the body
   *  accessor to patch. Defaults to the ambient `Response`; callers must pass
   *  the target realm's constructor when patching an iframe / shadow realm
   *  so `stop()` restores the getter on the correct prototype. */
  targetResponse?: ResponseCtorLike,
  /** Present when the user-interaction cancel trigger is armed. Every request
   *  gets a chaos-owned AbortController merged with the caller's signal and
   *  registered here, so `cancelAll()` aborts whatever is still in flight.
   *  Aborting an already-consumed response is a spec-level no-op, which keeps
   *  registration free of completion tracking. */
  cancelRegistry?: StreamCancelRegistry,
): FetchStreamPatchHandle {
  let running = true;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const activeControllers = new Set<TransformStreamDefaultController<Uint8Array>>();
  const terminatedResponses = new WeakSet<object>();
  const replayControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  // Resolve the replay plan once (fixture + mutations are fixed for the life of
  // the config); the same immutable plan is reused across matched requests.
  const replayPlan: ReplayPlan | null = config.replay
    ? resolveReplay(config.replay.data, config.replay.mutations)
    : null;
  const replayLifecycle: ReplayLifecycle = {
    terminated: () => !running,
    registerController: (c) => replayControllers.add(c),
    unregisterController: (c) => replayControllers.delete(c),
    registerTimer: (h) => pendingTimers.add(h),
    unregisterTimer: (h) => pendingTimers.delete(h),
  };

  const ResponseCtor: ResponseCtorLike = targetResponse ?? (Response as unknown as ResponseCtorLike);
  const originalBodyDescriptor = Object.getOwnPropertyDescriptor(ResponseCtor.prototype, 'body');
  const originalBodyGetter = originalBodyDescriptor?.get;
  if (!originalBodyGetter) {
    throw new Error('[chaos-maker] Response.prototype.body getter is not available; fetch-stream chaos cannot install.');
  }

  // Install the patched getter. A marker symbol is attached so a second
  // ChaosMaker instance can recognise the existing patch and bail without
  // double-wrapping (the active-instance check in ChaosMaker.start() should
  // prevent this in practice, but the marker keeps the failure mode loud).
  const patchedGetter = function patchedBody(this: Response): ReadableStream<Uint8Array> | null {
    const native = originalBodyGetter.call(this) as ReadableStream<Uint8Array> | null;
    if (!native) return null;
    if (!running) return native;
    const meta = RESPONSE_META.get(this);
    if (!meta) return native;

    // Substitute-mode replay: discard the real body, serve the fixture stream.
    if (meta.replayPlan) {
      if (!meta.wrappedBody) {
        try {
          // Discard the real body. `cancel()` returns a promise that can reject
          // on a locked/disturbed stream, so swallow it to avoid an unhandled
          // rejection in addition to the synchronous guard.
          native.cancel().catch(() => {});
        } catch {
          // native may already be locked / disturbed; ignore
        }
        meta.wrappedBody = buildReplayStream(meta.replayPlan, meta, emitter, replayLifecycle);
      }
      return meta.wrappedBody;
    }

    if (!meta.wrappedBody) {
      const lifecycle = {
        terminated: () => terminatedResponses.has(this) || !running,
        markTerminated: () => terminatedResponses.add(this),
        registerController: (c: TransformStreamDefaultController<Uint8Array>) => activeControllers.add(c),
        registerTimer: (h: ReturnType<typeof setTimeout>) => pendingTimers.add(h),
        unregisterTimer: (h: ReturnType<typeof setTimeout>) => pendingTimers.delete(h),
      };
      try {
        meta.wrappedBody = wrapChaosBranch(native, meta, config, random, emitter, counters, groups, lifecycle);
      } catch {
        // Native body already locked / disturbed; nothing to wrap.
        return native;
      }
    }
    return meta.wrappedBody;
  };
  Object.defineProperty(patchedGetter, BODY_GETTER_PATCH_MARKER, { value: true });
  Object.defineProperty(ResponseCtor.prototype, 'body', {
    configurable: true,
    get: patchedGetter,
  });

  const wrappedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    const parsedUrl = parseRequestUrl(url);

    // User-interaction cancel support: swap in a chaos-owned AbortController
    // whose signal mirrors the caller's, register it, and let `cancelAll()`
    // abort whatever is still streaming at trigger time. The manual merge
    // (instead of AbortSignal.any) keeps older engines working.
    let effectiveInit = init;
    let cancelConnection: CancelableStreamConnection | undefined;
    if (running && cancelRegistry) {
      const controller = new AbortController();
      const callerSignal =
        init?.signal ??
        (input && typeof input === 'object' && 'signal' in input
          ? (input as Request).signal
          : undefined);
      if (callerSignal) {
        if (callerSignal.aborted) {
          controller.abort();
        } else {
          callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }
      }
      effectiveInit = { ...init, signal: controller.signal };
      cancelConnection = {
        transport: 'fetch-stream',
        url,
        cancel: () => {
          if (controller.signal.aborted) return false;
          controller.abort();
          return true;
        },
      };
      cancelRegistry.register(cancelConnection);
    }

    // Replay: when a request matches the replay directive, the consumer is
    // driven from the fixture rather than the network. Takes precedence over
    // the per-chunk rules for that request.
    if (running && config.replay && replayPlan) {
      const gate = gateTransportRule(config.replay, url, () => parsedUrl);
      if (gate.proceed) {
        const meta: ResponseChaosMeta = { url, parsedUrl, connectionId: mintConnectionId() };
        if (cancelConnection) cancelConnection.connectionId = meta.connectionId;
        if (config.replay.blockUpstream ?? true) {
          // Block mode: never touch the network; own the whole Response. The
          // fixture stream is timer-based and never sees the injected
          // AbortController, so unregister the cancel hook here: leaving it
          // would let `cancelAll()` report an applied cancel for a connection
          // that keeps streaming.
          if (cancelConnection) cancelRegistry?.unregister(cancelConnection);
          return buildReplayResponse(
            config.replay,
            replayPlan,
            meta,
            emitter,
            replayLifecycle,
            ResponseCtor as unknown as ResponseConstructor,
          );
        }
        // Substitute mode: let the request fire, replace the body on `.body`.
        const substituteResponse = await originalFetch(input as RequestInfo, effectiveInit);
        if (!running) return substituteResponse;
        meta.replayPlan = replayPlan;
        RESPONSE_META.set(substituteResponse, meta);
        return substituteResponse;
      }
    }

    const response = await originalFetch(input as RequestInfo, effectiveInit);
    if (!running) return response;
    const matches = urlMatchesAnyRule(config, url, parsedUrl);
    if (!matches.matched) return response;
    const meta: ResponseChaosMeta = {
      url,
      parsedUrl,
      connectionId: mintConnectionId(),
    };
    if (cancelConnection) cancelConnection.connectionId = meta.connectionId;
    RESPONSE_META.set(response, meta);
    return response;
  };

  return {
    fetch: wrappedFetch,
    uninstall(): void {
      running = false;
      for (const handle of pendingTimers) clearTimeout(handle);
      pendingTimers.clear();
      for (const controller of activeControllers) {
        try {
          controller.terminate();
        } catch {
          // already terminated
        }
      }
      activeControllers.clear();
      for (const controller of replayControllers) {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
      replayControllers.clear();
      // Restore the body getter to whatever was there before patching.
      if (originalBodyDescriptor) {
        Object.defineProperty(ResponseCtor.prototype, 'body', originalBodyDescriptor);
      }
    },
  };
}
