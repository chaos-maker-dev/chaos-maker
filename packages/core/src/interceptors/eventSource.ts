/**
 * EventSource (Server-Sent Events) chaos interceptor.
 *
 * Mirrors the WebSocket interceptor's wrapper-constructor strategy: replace
 * `globalThis.EventSource` with a chaos wrapper that owns a hidden real
 * `EventSource` instance, intercepts inbound `MessageEvent`s on the capture
 * phase via `stopImmediatePropagation`, and re-dispatches mutated payloads.
 *
 * Design notes:
 * - SSE is inbound-only (the spec defines no client → server channel beyond
 *   the initial GET), so direction/payloadType fields are absent vs. WS.
 * - `event.data` is always a string per the spec  -  corruption strategies
 *   reuse the four text strategies from network/WS chaos.
 * - Counting (onNth/everyNth/afterN) is per-rule, per-event, identical to WS.
 * - Per-rule ordering on a matched event: drop → corrupt → delay. A dropped
 *   event short-circuits the rest.
 * - Close chaos dispatches an `error` event then calls `.close()` on the
 *   underlying EventSource. Delivery of `error` mirrors what browsers do
 *   when the upstream connection drops; the app's reconnection logic (if any)
 *   re-runs the original `new EventSource(url)` path, so a fresh wrapper is
 *   created and chaos continues.
 * - On `uninstall()`, every pending delay timer is cleared and an
 *   `sse:drop` is emitted for it with `reason: 'stop-during-delay'`. Pending
 *   close timers cancel silently (they had not fired anything yet).
 */

import {
  SSEConfig,
  SSEDropConfig,
  SSEDelayConfig,
  SSECorruptConfig,
  SSECloseConfig,
  SSECorruptionStrategy,
  RequestCountingOptions,
  HostnameMatcher,
  RequestKvMatcher,
} from '../config';
import { ChaosEventEmitter } from '../events';
import { resolveReplay, type ReplayPlan } from '../ai/replay';
import { shouldApplyChaos, matchUrl, incrementCounter, checkCountingCondition, corruptText, gateGroup } from '../utils';
import {
  parseRequestUrl,
  matchHostname,
  matchQueryParams,
  type ParsedRequestUrl,
} from '../matchers';
import type { RuleGroupRegistry } from '../groups';
import type { StreamCancelRegistry } from './streamCancelRegistry';

const INTERCEPT_MARKER = Symbol.for('chaos-maker.eventsource.intercepted');

type WildcardOrString = string | undefined;

interface PendingDelayTimer {
  kind: 'delay';
  handle: ReturnType<typeof setTimeout>;
  url: string;
  eventType: string;
  connectionId: string;
  chunkIndex: number;
}

interface PendingCloseTimer {
  kind: 'close';
  handle: ReturnType<typeof setTimeout>;
}

interface PendingReplayTimer {
  kind: 'replay';
  handle: ReturnType<typeof setTimeout>;
}

type PendingTimer = PendingDelayTimer | PendingCloseTimer | PendingReplayTimer;

export interface EventSourceLikeStatic {
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSED: 2;
  new (url: string | URL, init?: EventSourceInit): EventSource;
  prototype: EventSource;
}

export interface EventSourcePatchHandle {
  /** Wrapped EventSource constructor suitable for `globalThis.EventSource = …`. */
  readonly Wrapped: typeof EventSource;
  /** Cancel pending timers and disarm wrapped instances. Call on ChaosMaker.stop(). */
  uninstall(): void;
}

function eventTypeMatches(rule: WildcardOrString, actual: string): boolean {
  if (rule === undefined || rule === '*') return true;
  return rule === actual;
}

interface SseGateResult {
  proceed: boolean;
  matchedBy?: string[];
  skippedAt?: string;
}

function gateSseRule(
  rule: {
    urlPattern?: string;
    eventType?: WildcardOrString;
    hostname?: HostnameMatcher;
    queryParams?: Record<string, RequestKvMatcher>;
  },
  url: string,
  eventType: string,
  getParsedUrl: () => ParsedRequestUrl | null,
): SseGateResult {
  if (!matchUrl(url, rule.urlPattern)) return { proceed: false, skippedAt: 'urlPattern' };
  if (!eventTypeMatches(rule.eventType, eventType)) return { proceed: false, skippedAt: 'eventType' };
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

function findFiringRule<T extends RequestCountingOptions & {
  urlPattern?: string;
  eventType?: WildcardOrString;
  hostname?: HostnameMatcher;
  queryParams?: Record<string, RequestKvMatcher>;
  probability: number;
  group?: string;
}>(
  rules: T[] | undefined,
  url: string,
  eventType: string,
  random: () => number,
  counters: Map<object, number>,
  groups: RuleGroupRegistry | undefined,
  emitter: ChaosEventEmitter | undefined,
  getParsedUrl: () => ParsedRequestUrl | null,
): T | null {
  if (!rules) return null;
  for (const rule of rules) {
    emitter?.debug('rule-evaluating', { url, eventType }, rule as object);
    const gate = gateSseRule(rule, url, eventType, getParsedUrl);
    if (!gate.proceed) {
      emitter?.debug('rule-skip-match', { url, eventType, skippedAt: gate.skippedAt }, rule as object);
      continue;
    }
    emitter?.debug('rule-matched', { url, eventType, matchedBy: gate.matchedBy }, rule as object);
    const count = incrementCounter(rule, counters);
    if (!checkCountingCondition(rule, count)) {
      emitter?.debug('rule-skip-counting', { url, eventType }, rule as object);
      continue;
    }
    if (!gateGroup(rule, groups, emitter, { url, eventType })) continue;
    if (!shouldApplyChaos(rule.probability, random)) {
      emitter?.debug('rule-skip-probability', { url, eventType }, rule as object);
      continue;
    }
    emitter?.debug('rule-applied', { url, eventType }, rule as object);
    return rule;
  }
  return null;
}

interface ConnectionContext {
  url: string;
  connectionId: string;
  chunkIndex: number;
  /** True once replay takes over the source: real inbound events are then
   *  suppressed and the fixture drives synthetic `message` events. */
  replaying?: boolean;
}

function emitDrop(emitter: ChaosEventEmitter, ctx: ConnectionContext, eventType: string, reason?: string): void {
  emitter.emit({
    type: 'sse:drop',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: ctx.url,
      eventType,
      connectionId: ctx.connectionId,
      chunkIndex: ctx.chunkIndex,
      ...(reason ? { reason } : {}),
    },
  });
}

function emitDelay(emitter: ChaosEventEmitter, ctx: ConnectionContext, eventType: string, delayMs: number): void {
  emitter.emit({
    type: 'sse:delay',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: ctx.url,
      eventType,
      delayMs,
      connectionId: ctx.connectionId,
      chunkIndex: ctx.chunkIndex,
      phase: 'ai:stream-paused',
    },
  });
}

function emitCorrupt(emitter: ChaosEventEmitter, ctx: ConnectionContext, eventType: string, strategy: SSECorruptionStrategy): void {
  emitter.emit({
    type: 'sse:corrupt',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: ctx.url,
      eventType,
      strategy,
      connectionId: ctx.connectionId,
      chunkIndex: ctx.chunkIndex,
    },
  });
}

function emitClose(emitter: ChaosEventEmitter, ctx: ConnectionContext, reason: string): void {
  emitter.emit({
    type: 'sse:close',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: ctx.url,
      reason,
      connectionId: ctx.connectionId,
      chunkIndex: ctx.chunkIndex,
      phase: 'ai:stream-truncated',
    },
  });
}

function emitFirstChunkMarker(emitter: ChaosEventEmitter, ctx: ConnectionContext, eventType: string): void {
  emitter.emit({
    type: 'sse:lifecycle',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: ctx.url,
      eventType,
      connectionId: ctx.connectionId,
      chunkIndex: 0,
      phase: 'ai:first-chunk',
    },
  });
}

function emitStreamResumedMarker(emitter: ChaosEventEmitter, ctx: ConnectionContext, eventType: string): void {
  emitter.emit({
    type: 'sse:lifecycle',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: ctx.url,
      eventType,
      connectionId: ctx.connectionId,
      chunkIndex: ctx.chunkIndex,
      phase: 'ai:stream-resumed',
    },
  });
}

function emitReplayStarted(emitter: ChaosEventEmitter, ctx: ConnectionContext, eventType: string): void {
  emitter.emit({
    type: 'sse:lifecycle',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: ctx.url,
      eventType,
      connectionId: ctx.connectionId,
      chunkIndex: 0,
      phase: 'ai:stream-replayed',
    },
  });
}

function emitReplayDuplicate(emitter: ChaosEventEmitter, ctx: ConnectionContext, eventType: string): void {
  emitter.emit({
    type: 'sse:lifecycle',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url: ctx.url,
      eventType,
      connectionId: ctx.connectionId,
      chunkIndex: ctx.chunkIndex,
      phase: 'ai:chunk-duplicated',
    },
  });
}

let _sseConnectionCounter = 0;
function mintConnectionId(): string {
  const c = (typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined);
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // fall through
    }
  }
  _sseConnectionCounter += 1;
  return `chaos-sse-${_sseConnectionCounter}`;
}

export function patchEventSource(
  OriginalEventSource: EventSourceLikeStatic,
  config: SSEConfig,
  emitter: ChaosEventEmitter,
  random: () => number,
  counters: Map<object, number>,
  groups?: RuleGroupRegistry,
  /** Present when the user-interaction cancel trigger is armed. Every wrapped
   *  source registers a cancel hook that closes it and dispatches `error`,
   *  mirroring the close-chaos teardown so app error handlers engage. */
  cancelRegistry?: StreamCancelRegistry,
): EventSourcePatchHandle {
  const pendingTimersBySource = new Map<EventSource, Set<PendingTimer>>();
  const contextBySource = new WeakMap<EventSource, ConnectionContext>();
  let running = true;

  // Resolve the replay plan once; the same immutable plan drives every matched
  // source.
  const replayPlan: ReplayPlan | null = config.replay
    ? resolveReplay(config.replay.data, config.replay.mutations)
    : null;

  const trackTimer = (source: EventSource, timer: PendingTimer): void => {
    let set = pendingTimersBySource.get(source);
    if (!set) {
      set = new Set();
      pendingTimersBySource.set(source, set);
    }
    set.add(timer);
  };

  const untrackTimer = (source: EventSource, timer: PendingTimer): void => {
    const set = pendingTimersBySource.get(source);
    if (!set) return;
    set.delete(timer);
    if (set.size === 0) {
      pendingTimersBySource.delete(source);
    }
  };

  const clearSourceTimers = (source: EventSource, reason: string): void => {
    const set = pendingTimersBySource.get(source);
    if (!set) return;
    for (const timer of set) {
      clearTimeout(timer.handle);
      if (timer.kind === 'delay') {
        emitDrop(
          emitter,
          { url: timer.url, connectionId: timer.connectionId, chunkIndex: timer.chunkIndex },
          timer.eventType,
          reason,
        );
      }
    }
    pendingTimersBySource.delete(source);
  };

  const redispatch = (source: EventSource, original: MessageEvent, data: string): void => {
    const newEvent = new MessageEvent(original.type || 'message', {
      data,
      origin: original.origin,
      lastEventId: original.lastEventId,
    });
    (newEvent as unknown as Record<symbol, unknown>)[INTERCEPT_MARKER] = true;
    source.dispatchEvent(newEvent);
  };

  const handleInbound = (source: EventSource, url: string, msgEvt: MessageEvent): void => {
    if ((msgEvt as unknown as Record<symbol, unknown>)[INTERCEPT_MARKER]) return;
    if (!running) return;

    // `MessageEvent.type` reflects the SSE event name, defaulting to 'message'
    // for unnamed events.
    const eventType = msgEvt.type || 'message';
    const ctx = contextBySource.get(source);
    if (!ctx) return; // wrapper was uninstalled between message dispatch + capture
    // Replay owns this source: swallow every real inbound event so the app
    // sees only the fixture-driven messages.
    if (ctx.replaying) {
      msgEvt.stopImmediatePropagation();
      return;
    }
    ctx.chunkIndex += 1;
    const isFirstChunk = ctx.chunkIndex === 0;
    if (isFirstChunk) {
      emitFirstChunkMarker(emitter, ctx, eventType);
    }

    let parsedCache: ParsedRequestUrl | null | undefined;
    const getParsedUrl = (): ParsedRequestUrl | null => {
      if (parsedCache === undefined) parsedCache = parseRequestUrl(url);
      return parsedCache;
    };

    if (findFiringRule<SSEDropConfig>(config.drops, url, eventType, random, counters, groups, emitter, getParsedUrl)) {
      msgEvt.stopImmediatePropagation();
      emitDrop(emitter, ctx, eventType);
      return;
    }

    let payload = typeof msgEvt.data === 'string' ? msgEvt.data : String(msgEvt.data);
    let mutated = false;

    const corruptRule = findFiringRule<SSECorruptConfig>(config.corruptions, url, eventType, random, counters, groups, emitter, getParsedUrl);
    if (corruptRule) {
      payload = corruptText(payload, corruptRule.strategy);
      mutated = true;
      emitCorrupt(emitter, ctx, eventType, corruptRule.strategy);
    }

    const delayRule = findFiringRule<SSEDelayConfig>(config.delays, url, eventType, random, counters, groups, emitter, getParsedUrl);
    if (delayRule) {
      msgEvt.stopImmediatePropagation();
      emitDelay(emitter, ctx, eventType, delayRule.delayMs);
      const delayedChunkIndex = ctx.chunkIndex;
      const timer: PendingDelayTimer = {
        kind: 'delay',
        handle: setTimeout(() => {
          untrackTimer(source, timer);
          // After stop, swallow the deferred dispatch; the wrapper is disarmed.
          if (!running) return;
          // App may have called source.close() while the message was queued.
          // EventTarget.dispatchEvent still fires synchronously on a closed
          // source, which would deliver a ghost message past close().
          // CLOSED = 2 per spec; check via constant on the source instance to
          // avoid hard-coding the literal here.
          if (source.readyState === source.CLOSED) return;
          emitStreamResumedMarker(
            emitter,
            { url, connectionId: ctx.connectionId, chunkIndex: delayedChunkIndex },
            eventType,
          );
          redispatch(source, msgEvt, payload);
        }, delayRule.delayMs),
        url,
        eventType,
        connectionId: ctx.connectionId,
        chunkIndex: delayedChunkIndex,
      };
      trackTimer(source, timer);
      return;
    }

    if (mutated) {
      msgEvt.stopImmediatePropagation();
      redispatch(source, msgEvt, payload);
    }
  };

  const findCloseRule = (url: string): SSECloseConfig | null => {
    if (!config.closes) return null;
    let parsedCache: ParsedRequestUrl | null | undefined;
    const getParsedUrl = (): ParsedRequestUrl | null => {
      if (parsedCache === undefined) parsedCache = parseRequestUrl(url);
      return parsedCache;
    };
    for (const rule of config.closes) {
      emitter.debug('rule-evaluating', { url }, rule);
      const gate = gateSseRule(
        { urlPattern: rule.urlPattern, eventType: '*', hostname: rule.hostname, queryParams: rule.queryParams },
        url,
        'message',
        getParsedUrl,
      );
      if (!gate.proceed) {
        emitter.debug('rule-skip-match', { url, skippedAt: gate.skippedAt }, rule);
        continue;
      }
      emitter.debug('rule-matched', { url, matchedBy: gate.matchedBy }, rule);
      const count = incrementCounter(rule, counters);
      if (!checkCountingCondition(rule, count)) {
        emitter.debug('rule-skip-counting', { url }, rule);
        continue;
      }
      if (!gateGroup(rule, groups, emitter, { url })) continue;
      if (!shouldApplyChaos(rule.probability, random)) {
        emitter.debug('rule-skip-probability', { url }, rule);
        continue;
      }
      emitter.debug('rule-applied', { url }, rule);
      return rule;
    }
    return null;
  };

  const scheduleCloseChaos = (source: EventSource, url: string): void => {
    const rule = findCloseRule(url);
    if (!rule) return;
    const afterMs = rule.afterMs ?? 0;

    const fire = (): void => {
      if (!running) return;
      clearSourceTimers(source, 'close-interrupt');
      const ctx = contextBySource.get(source) ?? { url, connectionId: mintConnectionId(), chunkIndex: -1 };
      emitClose(emitter, ctx, 'chaos-maker-close');
      // WHATWG SSE: on permanent failure, readyState must transition to
      // CLOSED *before* the error dispatch  -  so app onerror handlers that
      // branch on `readyState === CLOSED` see the correct state.
      try {
        source.close();
      } catch {
        // already closed
      }
      try {
        source.dispatchEvent(new Event('error'));
      } catch {
        // never thrown by EventTarget.dispatchEvent in practice; swallow defensively
      }
    };

    if (afterMs <= 0) {
      // Schedule on next tick so app code that attaches listeners
      // synchronously after `new EventSource(...)` still sees the close.
      const timer: PendingCloseTimer = { kind: 'close', handle: setTimeout(fire, 0) };
      trackTimer(source, timer);
    } else {
      const timer: PendingCloseTimer = { kind: 'close', handle: setTimeout(fire, afterMs) };
      trackTimer(source, timer);
    }
  };

  const dispatchSyntheticMessage = (source: EventSource, data: string): void => {
    const ev = new MessageEvent('message', { data });
    (ev as unknown as Record<symbol, unknown>)[INTERCEPT_MARKER] = true;
    source.dispatchEvent(ev);
  };

  const scheduleReplay = (source: EventSource, url: string): void => {
    if (!config.replay || !replayPlan) return;
    const directive = config.replay as {
      urlPattern?: string;
      hostname?: HostnameMatcher;
      queryParams?: Record<string, RequestKvMatcher>;
    };
    const gate = gateSseRule(
      { urlPattern: directive.urlPattern, eventType: '*', hostname: directive.hostname, queryParams: directive.queryParams },
      url,
      'message',
      () => parseRequestUrl(url),
    );
    if (!gate.proceed) return;
    const ctx = contextBySource.get(source);
    if (!ctx) return;
    ctx.replaying = true;
    emitReplayStarted(emitter, ctx, 'message');

    const plan = replayPlan;
    plan.pieces.forEach((piece, i) => {
      const timer: PendingReplayTimer = {
        kind: 'replay',
        handle: setTimeout(() => {
          untrackTimer(source, timer);
          if (!running) return;
          if (source.readyState === source.CLOSED) return;
          if (i === 0) emitFirstChunkMarker(emitter, ctx, 'message');
          dispatchSyntheticMessage(source, piece.text);
          if (piece.kind === 'duplicate') {
            emitReplayDuplicate(
              emitter,
              { url: ctx.url, connectionId: ctx.connectionId, chunkIndex: piece.sourceIndex },
              'message',
            );
          }
        }, piece.emitAtMs),
      };
      trackTimer(source, timer);
    });

    if (plan.truncated) {
      const lastAtMs = plan.pieces.reduce((max, p) => Math.max(max, p.emitAtMs), 0);
      const lastSourceIndex = plan.pieces.length ? plan.pieces[plan.pieces.length - 1].sourceIndex : -1;
      const timer: PendingReplayTimer = {
        kind: 'replay',
        handle: setTimeout(() => {
          untrackTimer(source, timer);
          if (!running) return;
          if (source.readyState === source.CLOSED) return;
          emitClose(emitter, { url: ctx.url, connectionId: ctx.connectionId, chunkIndex: lastSourceIndex }, 'replay-truncate');
          try {
            source.close();
          } catch {
            // already closed
          }
          try {
            source.dispatchEvent(new Event('error'));
          } catch {
            // swallow defensively
          }
        }, lastAtMs),
      };
      trackTimer(source, timer);
    }
  };

  function ChaosEventSource(this: unknown, url: string | URL, init?: EventSourceInit): EventSource {
    const source = new OriginalEventSource(url, init);
    const urlStr = typeof url === 'string' ? url : url.toString();
    const ctx: ConnectionContext = { url: urlStr, connectionId: mintConnectionId(), chunkIndex: -1 };
    contextBySource.set(source, ctx);

    if (cancelRegistry) {
      cancelRegistry.register({
        transport: 'sse',
        url: urlStr,
        connectionId: ctx.connectionId,
        cancel: () => {
          if (source.readyState === source.CLOSED) return false;
          clearSourceTimers(source, 'user-cancel');
          try {
            source.close();
          } catch {
            // already closed
          }
          try {
            source.dispatchEvent(new Event('error'));
          } catch {
            // never thrown by EventTarget.dispatchEvent in practice
          }
          return true;
        },
      });
    }

    // Capture-phase listener so we run before any user-attached message
    // handler; `stopImmediatePropagation` then prevents the raw event from
    // reaching the app when we drop / delay / corrupt.
    const messageHandler = (evt: Event): void => {
      handleInbound(source, urlStr, evt as MessageEvent);
    };
    const installedChaosTypes = new Set<string>();
    const realAddEventListener = source.addEventListener.bind(source);
    const installChaosListenerFor = (type: string): void => {
      if (installedChaosTypes.has(type)) return;
      installedChaosTypes.add(type);
      realAddEventListener(type, messageHandler, { capture: true });
    };

    installChaosListenerFor('message');

    // Pre-attach for any specific eventType named in a rule so chaos still
    // fires even if the app never listens for it (matches WS interceptor's
    // unconditional inbound interception).
    const collect = (rules?: { eventType?: WildcardOrString }[]): void => {
      if (!rules) return;
      for (const r of rules) {
        if (r.eventType && r.eventType !== '*' && r.eventType !== 'message') {
          installChaosListenerFor(r.eventType);
        }
      }
    };
    collect(config.drops);
    collect(config.delays);
    collect(config.corruptions);

    // Wildcard rules ('*') need to see every event the app subscribes to, but
    // we can't enumerate event names upfront. Wrap addEventListener so any
    // app-side subscription for a named event auto-installs the chaos
    // capture listener for that same type. 'open' and 'error' are control
    // events; never message-bearing, so skip them.
    const patchedAddEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void => {
      if (type !== 'open' && type !== 'error') {
        installChaosListenerFor(type);
      }
      // Cast back through the EventSource overloaded signature; the runtime
      // call is forwarded unchanged.
      (realAddEventListener as unknown as (
        t: string,
        l: EventListenerOrEventListenerObject | null,
        o?: boolean | AddEventListenerOptions,
      ) => void)(type, listener, options);
    };
    (source as unknown as { addEventListener: typeof patchedAddEventListener }).addEventListener =
      patchedAddEventListener;

    scheduleReplay(source, urlStr);
    scheduleCloseChaos(source, urlStr);

    return source;
  }

  Object.defineProperty(ChaosEventSource, 'prototype', {
    value: OriginalEventSource.prototype,
    writable: false,
  });
  for (const key of ['CONNECTING', 'OPEN', 'CLOSED'] as const) {
    (ChaosEventSource as unknown as Record<string, unknown>)[key] =
      (OriginalEventSource as unknown as Record<string, unknown>)[key];
  }

  return {
    Wrapped: ChaosEventSource as unknown as typeof EventSource,
    uninstall(): void {
      running = false;
      for (const [, timers] of pendingTimersBySource) {
        for (const timer of timers) {
          clearTimeout(timer.handle);
          if (timer.kind === 'delay') {
            emitDrop(
              emitter,
              { url: timer.url, connectionId: timer.connectionId, chunkIndex: timer.chunkIndex },
              timer.eventType,
              'stop-during-delay',
            );
          }
        }
      }
      pendingTimersBySource.clear();
    },
  };
}
