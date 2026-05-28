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
 * Double-read safety: `ReadableStream.tee()` runs on the first body access so
 * the second access (e.g. inside `Response.json()` after the consumer
 * already read `.body`) gets the unmutated branch instead of a locked
 * stream. The first reader receives the chaos-wrapped branch.
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
  RequestCountingOptions,
  HostnameMatcher,
  RequestKvMatcher,
} from '../config';
import { ChaosEventEmitter } from '../events';
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
  matchQueryParams,
  type ParsedRequestUrl,
} from '../matchers';
import type { RuleGroupRegistry } from '../groups';

const RESPONSE_META = new WeakMap<Response, ResponseChaosMeta>();
const BODY_GETTER_PATCH_MARKER = Symbol.for('chaos-maker.fetch-stream.body-getter');

interface ResponseChaosMeta {
  url: string;
  connectionId: string;
  parsedUrl: ParsedRequestUrl | null;
  /** Per-response lazy tee state populated on first `.body` access. */
  teeState?: {
    chaos: ReadableStream<Uint8Array>;
    original: ReadableStream<Uint8Array>;
    /** Toggled to `true` after the chaos branch is handed out, so the next
     *  `.body` access gets the unmutated branch (matches `tee()` semantics
     *  but routed deterministically so the first reader is always the
     *  chaos branch). */
    chaosBranchHandedOut: boolean;
  };
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

function emitDelay(emitter: ChaosEventEmitter, meta: ResponseChaosMeta, chunkIndex: number, delayMs: number, bytes: number): void {
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
    },
  });
}

function emitCorrupt(
  emitter: ChaosEventEmitter,
  meta: ResponseChaosMeta,
  chunkIndex: number,
  strategy: FetchStreamCorruptionStrategy,
  bytes: number,
): void {
  emitter.emit({
    type: 'fetch-stream:chunk-corrupted',
    timestamp: Date.now(),
    applied: true,
    detail: { url: meta.url, connectionId: meta.connectionId, chunkIndex, strategy, chunkBytes: bytes },
  });
}

function emitDuplicate(emitter: ChaosEventEmitter, meta: ResponseChaosMeta, chunkIndex: number, bytes: number): void {
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
    },
  });
}

function emitTruncate(emitter: ChaosEventEmitter, meta: ResponseChaosMeta, reason: string, chunkIndex: number): void {
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

function mutateChunkText(chunk: Uint8Array, strategy: FetchStreamCorruptionStrategy): { out: Uint8Array; binarySkip: boolean } {
  if (strategy === 'duplicate') {
    // Emission-level; caller enqueues twice. No text mutation.
    return { out: chunk, binarySkip: false };
  }
  // Attempt UTF-8 decode; if it throws, treat as binary and skip text strategies.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(chunk);
  } catch {
    return { out: chunk, binarySkip: true };
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
  lifecycle: { terminated: () => boolean; markTerminated: () => void; registerController: (c: TransformStreamDefaultController<Uint8Array>) => void; registerTimer: (handle: ReturnType<typeof setTimeout>) => void; },
): ReadableStream<Uint8Array> {
  let chunkIndex = -1;
  const closeRule = findFiringCloseRule(config.closes, meta, random, counters, groups, emitter);
  const closeAfterChunkScheduled: number | undefined = closeRule?.afterChunk;
  const closeAfterMsScheduled: number | undefined = closeRule?.afterMs;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      lifecycle.registerController(controller);
      if (closeAfterMsScheduled !== undefined) {
        const handle = setTimeout(() => {
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
      const corruptRule = findFiringChunkRule<FetchStreamCorruptConfig>(config.corruptions, meta, chunkIndex, random, counters, groups, emitter);
      let duplicate = false;
      if (corruptRule) {
        if (corruptRule.strategy === 'duplicate') {
          duplicate = true;
        } else {
          const { out, binarySkip } = mutateChunkText(chunk, corruptRule.strategy);
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
            emitCorrupt(emitter, meta, chunkIndex, corruptRule.strategy, bytes);
          }
        }
      }

      const delayRule = findFiringChunkRule<FetchStreamDelayConfig>(config.delays, meta, chunkIndex, random, counters, groups, emitter);
      if (delayRule) {
        emitDelay(emitter, meta, chunkIndex, delayRule.delayMs, bytes);
        await new Promise<void>((resolve) => {
          const handle = setTimeout(() => resolve(), delayRule.delayMs);
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

export function patchFetchStream(
  originalFetch: typeof fetch,
  config: FetchStreamConfig,
  random: () => number,
  emitter: ChaosEventEmitter,
  counters: Map<object, number>,
  groups?: RuleGroupRegistry,
): FetchStreamPatchHandle {
  let running = true;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const activeControllers = new Set<TransformStreamDefaultController<Uint8Array>>();
  const terminatedResponses = new WeakSet<Response>();

  const originalBodyDescriptor = Object.getOwnPropertyDescriptor(Response.prototype, 'body');
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

    if (!meta.teeState) {
      let teed: [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>];
      try {
        teed = native.tee() as [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>];
      } catch {
        // Stream already locked / consumed; nothing to do.
        return native;
      }
      const [forChaos, forFallback] = teed;
      const lifecycle = {
        terminated: () => terminatedResponses.has(this) || !running,
        markTerminated: () => terminatedResponses.add(this),
        registerController: (c: TransformStreamDefaultController<Uint8Array>) => activeControllers.add(c),
        registerTimer: (h: ReturnType<typeof setTimeout>) => pendingTimers.add(h),
      };
      meta.teeState = {
        chaos: wrapChaosBranch(forChaos, meta, config, random, emitter, counters, groups, lifecycle),
        original: forFallback,
        chaosBranchHandedOut: false,
      };
    }
    if (!meta.teeState.chaosBranchHandedOut) {
      meta.teeState.chaosBranchHandedOut = true;
      return meta.teeState.chaos;
    }
    return meta.teeState.original;
  };
  Object.defineProperty(patchedGetter, BODY_GETTER_PATCH_MARKER, { value: true });
  Object.defineProperty(Response.prototype, 'body', {
    configurable: true,
    get: patchedGetter,
  });

  const wrappedFetch: typeof fetch = async (input, init) => {
    const response = await originalFetch(input as RequestInfo, init);
    if (!running) return response;
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    const parsedUrl = parseRequestUrl(url);
    const matches = urlMatchesAnyRule(config, url, parsedUrl);
    if (!matches.matched) return response;
    RESPONSE_META.set(response, {
      url,
      parsedUrl,
      connectionId: mintConnectionId(),
    });
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
      // Restore the body getter to whatever was there before patching.
      if (originalBodyDescriptor) {
        Object.defineProperty(Response.prototype, 'body', originalBodyDescriptor);
      }
    },
  };
}
