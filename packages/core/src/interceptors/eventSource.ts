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
 * - `event.data` is always a string per the spec — corruption strategies
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
} from '../config';
import { ChaosEventEmitter } from '../events';
import { shouldApplyChaos, matchUrl, incrementCounter, checkCountingCondition, corruptText, gateGroup } from '../utils';
import type { RuleGroupRegistry } from '../groups';

const INTERCEPT_MARKER = Symbol.for('chaos-maker.eventsource.intercepted');

type WildcardOrString = string | undefined;

interface PendingDelayTimer {
  kind: 'delay';
  handle: ReturnType<typeof setTimeout>;
  url: string;
  eventType: string;
}

interface PendingCloseTimer {
  kind: 'close';
  handle: ReturnType<typeof setTimeout>;
}

type PendingTimer = PendingDelayTimer | PendingCloseTimer;

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

function findFiringRule<T extends RequestCountingOptions & { urlPattern?: string; eventType?: WildcardOrString; probability: number; group?: string }>(
  rules: T[] | undefined,
  url: string,
  eventType: string,
  random: () => number,
  counters: Map<object, number>,
  groups: RuleGroupRegistry | undefined,
  emitter: ChaosEventEmitter | undefined,
): T | null {
  if (!rules) return null;
  for (const rule of rules) {
    emitter?.debug('rule-evaluating', { url, eventType }, rule as object);
    if (!matchUrl(url, rule.urlPattern)) {
      emitter?.debug('rule-skip-match', { url, eventType }, rule as object);
      continue;
    }
    if (!eventTypeMatches(rule.eventType, eventType)) {
      emitter?.debug('rule-skip-match', { url, eventType }, rule as object);
      continue;
    }
    emitter?.debug('rule-matched', { url, eventType }, rule as object);
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

function emitDrop(emitter: ChaosEventEmitter, url: string, eventType: string, reason?: string): void {
  emitter.emit({
    type: 'sse:drop',
    timestamp: Date.now(),
    applied: true,
    detail: { url, eventType, ...(reason ? { reason } : {}) },
  });
}

function emitDelay(emitter: ChaosEventEmitter, url: string, eventType: string, delayMs: number): void {
  emitter.emit({
    type: 'sse:delay',
    timestamp: Date.now(),
    applied: true,
    detail: { url, eventType, delayMs },
  });
}

function emitCorrupt(emitter: ChaosEventEmitter, url: string, eventType: string, strategy: SSECorruptionStrategy): void {
  emitter.emit({
    type: 'sse:corrupt',
    timestamp: Date.now(),
    applied: true,
    detail: { url, eventType, strategy },
  });
}

function emitClose(emitter: ChaosEventEmitter, url: string, reason: string): void {
  emitter.emit({
    type: 'sse:close',
    timestamp: Date.now(),
    applied: true,
    detail: { url, reason },
  });
}

export function patchEventSource(
  OriginalEventSource: EventSourceLikeStatic,
  config: SSEConfig,
  emitter: ChaosEventEmitter,
  random: () => number,
  counters: Map<object, number>,
  groups?: RuleGroupRegistry,
): EventSourcePatchHandle {
  const pendingTimersBySource = new Map<EventSource, Set<PendingTimer>>();
  let running = true;

  const trackTimer = (source: EventSource, timer: PendingTimer): void => {
    let set = pendingTimersBySource.get(source);
    if (!set) {
      set = new Set();
      pendingTimersBySource.set(source, set);
    }
    set.add(timer);
  };

  const untrackTimer = (source: EventSource, timer: PendingTimer): void => {
    pendingTimersBySource.get(source)?.delete(timer);
  };

  const clearSourceTimers = (source: EventSource, reason: string): void => {
    const set = pendingTimersBySource.get(source);
    if (!set) return;
    for (const timer of set) {
      clearTimeout(timer.handle);
      if (timer.kind === 'delay') {
        emitDrop(emitter, timer.url, timer.eventType, reason);
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

    if (findFiringRule<SSEDropConfig>(config.drops, url, eventType, random, counters, groups, emitter)) {
      msgEvt.stopImmediatePropagation();
      emitDrop(emitter, url, eventType);
      return;
    }

    let payload = typeof msgEvt.data === 'string' ? msgEvt.data : String(msgEvt.data);
    let mutated = false;

    const corruptRule = findFiringRule<SSECorruptConfig>(config.corruptions, url, eventType, random, counters, groups, emitter);
    if (corruptRule) {
      payload = corruptText(payload, corruptRule.strategy);
      mutated = true;
      emitCorrupt(emitter, url, eventType, corruptRule.strategy);
    }

    const delayRule = findFiringRule<SSEDelayConfig>(config.delays, url, eventType, random, counters, groups, emitter);
    if (delayRule) {
      msgEvt.stopImmediatePropagation();
      emitDelay(emitter, url, eventType, delayRule.delayMs);
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
          redispatch(source, msgEvt, payload);
        }, delayRule.delayMs),
        url, eventType,
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
    for (const rule of config.closes) {
      emitter.debug('rule-evaluating', { url }, rule);
      if (!matchUrl(url, rule.urlPattern)) {
        emitter.debug('rule-skip-match', { url }, rule);
        continue;
      }
      emitter.debug('rule-matched', { url }, rule);
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
      emitClose(emitter, url, 'chaos-maker-close');
      // WHATWG SSE: on permanent failure, readyState must transition to
      // CLOSED *before* the error dispatch — so app onerror handlers that
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

  function ChaosEventSource(this: unknown, url: string | URL, init?: EventSourceInit): EventSource {
    const source = new OriginalEventSource(url, init);
    const urlStr = typeof url === 'string' ? url : url.toString();

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
            emitDrop(emitter, timer.url, timer.eventType, 'stop-during-delay');
          }
        }
      }
      pendingTimersBySource.clear();
    },
  };
}
