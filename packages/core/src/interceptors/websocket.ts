/**
 * WebSocket chaos interceptor.
 *
 * Design decisions (see V2_PHASE3_WEBSOCKET_PLAN.md §4, §9):
 * - Patch `globalThis.WebSocket` with a wrapper constructor. Real socket is returned
 *   so `instanceof WebSocket` continues to work. `.send` is overridden on the
 *   instance; inbound messages are intercepted via a listener installed *before*
 *   user code runs.
 * - Ordering of primitives on a matched message: drop → corrupt → delay.
 *   A dropped message short-circuits the remaining primitives.
 * - Counting for drop/delay/corrupt is per-rule, per-message. Counting for
 *   close is per-rule, per-connection.
 * - On `stop()`, the interceptor flips a `running` flag and cancels every
 *   pending timer. Any already-wrapped socket is disarmed in place so its
 *   patched `.send` and inbound listener become no-ops; pending delay timers
 *   emit `websocket:drop` with `detail.reason: 'stop-during-delay'`; pending
 *   close timers silently cancel (they never fired a close event).
 * - Close chaos clears pending-delay timers for the socket before closing.
 * - Binary corruption runs `truncate` / `empty` natively; `malformed-json` and
 *   `wrong-type` emit `applied: false` with `reason: 'incompatible-payload-type'`.
 */

import {
  WebSocketConfig,
  WebSocketDropConfig,
  WebSocketDelayConfig,
  WebSocketCorruptConfig,
  WebSocketDirection,
  WebSocketCorruptionStrategy,
  RequestCountingOptions,
  HostnameMatcher,
  RequestKvMatcher,
} from '../config';
import { ChaosEventEmitter } from '../events';
import { shouldApplyChaos, matchUrl, incrementCounter, checkCountingCondition, gateGroup } from '../utils';
import {
  parseRequestUrl,
  matchHostname,
  matchQueryParams,
  type ParsedRequestUrl,
} from '../matchers';
import type { RuleGroupRegistry } from '../groups';

type Direction = 'inbound' | 'outbound';
type PayloadType = 'text' | 'binary';

const INTERCEPT_MARKER = Symbol.for('chaos-maker.websocket.intercepted');

interface PendingDelayTimer {
  kind: 'delay';
  handle: ReturnType<typeof setTimeout>;
  url: string;
  direction: Direction;
  payloadType: PayloadType;
}

interface PendingCloseTimer {
  kind: 'close';
  handle: ReturnType<typeof setTimeout>;
}

type PendingTimer = PendingDelayTimer | PendingCloseTimer;

export interface WebSocketPatchHandle {
  /** Wrapped WebSocket constructor suitable for `globalThis.WebSocket = …`. */
  readonly Wrapped: typeof WebSocket;
  /** Clear all pending delay timers and emit drop events for them. Call on ChaosMaker.stop(). */
  uninstall(): void;
}

function directionApplies(configDir: WebSocketDirection, actual: Direction): boolean {
  if (configDir === 'both') return true;
  return configDir === actual;
}

function getPayloadType(data: unknown): PayloadType {
  return typeof data === 'string' ? 'text' : 'binary';
}

function corruptTextPayload(text: string, strategy: WebSocketCorruptionStrategy): string {
  switch (strategy) {
    case 'truncate':
      return text.slice(0, Math.max(0, Math.floor(text.length / 2)));
    case 'malformed-json':
      return `${text}"}`;
    case 'empty':
      return '';
    case 'wrong-type':
      return '<html><body>Unexpected HTML</body></html>';
  }
}

function corruptBinaryPayload(
  data: ArrayBuffer | ArrayBufferView | Blob,
  strategy: WebSocketCorruptionStrategy,
): ArrayBuffer | ArrayBufferView | Blob | null {
  if (strategy === 'malformed-json' || strategy === 'wrong-type') return null;
  if (strategy === 'empty') {
    if (typeof Blob !== 'undefined' && data instanceof Blob) return new Blob([]);
    if (data instanceof ArrayBuffer) return new ArrayBuffer(0);
    return new Uint8Array(0);
  }
  // truncate
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.slice(0, Math.max(0, Math.floor(data.size / 2)));
  }
  if (data instanceof ArrayBuffer) {
    return data.slice(0, Math.max(0, Math.floor(data.byteLength / 2)));
  }
  const view = data as ArrayBufferView;
  const end = Math.max(0, Math.floor(view.byteLength / 2));
  // Copy (not alias) to match the ArrayBuffer branch above and avoid leaking
  // mutations to/from the caller's underlying buffer.
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + end));
}

interface WsGateResult {
  proceed: boolean;
  matchedBy?: string[];
  skippedAt?: string;
}

function gateWsRule(
  rule: {
    urlPattern?: string;
    direction: WebSocketDirection;
    hostname?: HostnameMatcher;
    queryParams?: Record<string, RequestKvMatcher>;
  },
  url: string,
  direction: Direction,
  getParsedUrl: () => ParsedRequestUrl | null,
): WsGateResult {
  if (!matchUrl(url, rule.urlPattern)) return { proceed: false, skippedAt: 'urlPattern' };
  if (!directionApplies(rule.direction, direction)) return { proceed: false, skippedAt: 'direction' };
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
  direction: WebSocketDirection;
  hostname?: HostnameMatcher;
  queryParams?: Record<string, RequestKvMatcher>;
  probability: number;
  group?: string;
}>(
  rules: T[] | undefined,
  url: string,
  direction: Direction,
  random: () => number,
  counters: Map<object, number>,
  groups: RuleGroupRegistry | undefined,
  emitter: ChaosEventEmitter | undefined,
  getParsedUrl: () => ParsedRequestUrl | null,
): T | null {
  if (!rules) return null;
  for (const rule of rules) {
    emitter?.debug('rule-evaluating', { url, direction }, rule as object);
    const gate = gateWsRule(rule, url, direction, getParsedUrl);
    if (!gate.proceed) {
      emitter?.debug('rule-skip-match', { url, direction, skippedAt: gate.skippedAt }, rule as object);
      continue;
    }
    emitter?.debug('rule-matched', { url, direction, matchedBy: gate.matchedBy }, rule as object);
    const count = incrementCounter(rule, counters);
    if (!checkCountingCondition(rule, count)) {
      emitter?.debug('rule-skip-counting', { url, direction }, rule as object);
      continue;
    }
    if (!gateGroup(rule, groups, emitter, { url, direction })) continue;
    if (!shouldApplyChaos(rule.probability, random)) {
      emitter?.debug('rule-skip-probability', { url, direction }, rule as object);
      continue;
    }
    emitter?.debug('rule-applied', { url, direction }, rule as object);
    return rule;
  }
  return null;
}

function emitDrop(
  emitter: ChaosEventEmitter,
  url: string,
  direction: Direction,
  payloadType: PayloadType,
  reason?: string,
): void {
  emitter.emit({
    type: 'websocket:drop',
    timestamp: Date.now(),
    applied: true,
    detail: { url, direction, payloadType, ...(reason ? { reason } : {}) },
  });
}

function emitDelay(
  emitter: ChaosEventEmitter,
  url: string,
  direction: Direction,
  payloadType: PayloadType,
  delayMs: number,
): void {
  emitter.emit({
    type: 'websocket:delay',
    timestamp: Date.now(),
    applied: true,
    detail: { url, direction, payloadType, delayMs },
  });
}

function emitCorrupt(
  emitter: ChaosEventEmitter,
  url: string,
  direction: Direction,
  payloadType: PayloadType,
  strategy: string,
  applied: boolean,
  reason?: string,
): void {
  emitter.emit({
    type: 'websocket:corrupt',
    timestamp: Date.now(),
    applied,
    detail: { url, direction, payloadType, strategy, ...(reason ? { reason } : {}) },
  });
}

function emitClose(
  emitter: ChaosEventEmitter,
  url: string,
  code: number,
  reason: string,
): void {
  emitter.emit({
    type: 'websocket:close',
    timestamp: Date.now(),
    applied: true,
    detail: { url, closeCode: code, closeReason: reason },
  });
}

export function patchWebSocket(
  OriginalWebSocket: typeof WebSocket,
  config: WebSocketConfig,
  emitter: ChaosEventEmitter,
  random: () => number,
  counters: Map<object, number>,
  groups?: RuleGroupRegistry,
): WebSocketPatchHandle {
  const pendingTimersBySocket = new Map<WebSocket, Set<PendingTimer>>();
  // Set to false in uninstall() so that already-wrapped sockets stop applying
  // chaos on any subsequent message / scheduled close after ChaosMaker.stop().
  let running = true;

  const trackTimer = (socket: WebSocket, timer: PendingTimer): void => {
    let set = pendingTimersBySocket.get(socket);
    if (!set) {
      set = new Set();
      pendingTimersBySocket.set(socket, set);
    }
    set.add(timer);
  };

  const untrackTimer = (socket: WebSocket, timer: PendingTimer): void => {
    pendingTimersBySocket.get(socket)?.delete(timer);
  };

  const clearSocketTimers = (socket: WebSocket, reason: string): void => {
    const set = pendingTimersBySocket.get(socket);
    if (!set) return;
    for (const timer of set) {
      clearTimeout(timer.handle);
      // Only pending delays were observable as a "message in flight"; close
      // timers haven't emitted anything yet, so cancelling them is silent.
      if (timer.kind === 'delay') {
        emitDrop(emitter, timer.url, timer.direction, timer.payloadType, reason);
      }
    }
    pendingTimersBySocket.delete(socket);
  };

  const redispatch = (socket: WebSocket, original: MessageEvent, data: unknown): void => {
    const newEvent = new MessageEvent('message', {
      data,
      origin: original.origin,
      lastEventId: original.lastEventId,
      source: original.source,
      ports: Array.from(original.ports ?? []),
    });
    (newEvent as unknown as Record<symbol, unknown>)[INTERCEPT_MARKER] = true;
    socket.dispatchEvent(newEvent);
  };

  const handleOutbound = (
    socket: WebSocket,
    url: string,
    data: string | ArrayBuffer | ArrayBufferView | Blob,
    originalSend: (d: string | ArrayBuffer | ArrayBufferView | Blob) => void,
  ): { handled: boolean; data: string | ArrayBuffer | ArrayBufferView | Blob } => {
    // After stop(), leave existing sockets alone  -  pass the payload through
    // untouched so the real socket still behaves normally.
    if (!running) return { handled: false, data };

    const direction: Direction = 'outbound';
    const payloadType = getPayloadType(data);
    let parsedCache: ParsedRequestUrl | null | undefined;
    const getParsedUrl = (): ParsedRequestUrl | null => {
      if (parsedCache === undefined) parsedCache = parseRequestUrl(url);
      return parsedCache;
    };

    if (findFiringRule<WebSocketDropConfig>(config.drops, url, direction, random, counters, groups, emitter, getParsedUrl)) {
      emitDrop(emitter, url, direction, payloadType);
      return { handled: true, data };
    }

    let payload = data;
    const corruptRule = findFiringRule<WebSocketCorruptConfig>(config.corruptions, url, direction, random, counters, groups, emitter, getParsedUrl);
    if (corruptRule) {
      if (payloadType === 'text') {
        payload = corruptTextPayload(payload as string, corruptRule.strategy);
        emitCorrupt(emitter, url, direction, payloadType, corruptRule.strategy, true);
      } else {
        const corrupted = corruptBinaryPayload(payload as ArrayBuffer | ArrayBufferView | Blob, corruptRule.strategy);
        if (corrupted === null) {
          emitCorrupt(emitter, url, direction, payloadType, corruptRule.strategy, false, 'incompatible-payload-type');
        } else {
          payload = corrupted;
          emitCorrupt(emitter, url, direction, payloadType, corruptRule.strategy, true);
        }
      }
    }

    const delayRule = findFiringRule<WebSocketDelayConfig>(config.delays, url, direction, random, counters, groups, emitter, getParsedUrl);
    if (delayRule) {
      emitDelay(emitter, url, direction, payloadType, delayRule.delayMs);
      const timer: PendingDelayTimer = {
        kind: 'delay',
        handle: setTimeout(() => {
          untrackTimer(socket, timer);
          if (!running) return;
          try {
            originalSend(payload);
          } catch {
            // socket may have closed; matches real lost-message semantics
          }
        }, delayRule.delayMs),
        url, direction, payloadType,
      };
      trackTimer(socket, timer);
      return { handled: true, data: payload };
    }

    return { handled: false, data: payload };
  };

  const attachInboundListener = (socket: WebSocket, url: string): void => {
    socket.addEventListener('message', (evt: Event) => {
      const msgEvt = evt as MessageEvent;
      if ((msgEvt as unknown as Record<symbol, unknown>)[INTERCEPT_MARKER]) return;
      // After stop(), let the event through untouched to app listeners.
      if (!running) return;

      const direction: Direction = 'inbound';
      const payloadType = getPayloadType(msgEvt.data);
      let parsedCache: ParsedRequestUrl | null | undefined;
      const getParsedUrl = (): ParsedRequestUrl | null => {
        if (parsedCache === undefined) parsedCache = parseRequestUrl(url);
        return parsedCache;
      };

      if (findFiringRule<WebSocketDropConfig>(config.drops, url, direction, random, counters, groups, emitter, getParsedUrl)) {
        msgEvt.stopImmediatePropagation();
        emitDrop(emitter, url, direction, payloadType);
        return;
      }

      let payload: unknown = msgEvt.data;
      let wasCorrupted = false;
      const corruptRule = findFiringRule<WebSocketCorruptConfig>(config.corruptions, url, direction, random, counters, groups, emitter, getParsedUrl);
      if (corruptRule) {
        if (payloadType === 'text') {
          payload = corruptTextPayload(payload as string, corruptRule.strategy);
          wasCorrupted = true;
          emitCorrupt(emitter, url, direction, payloadType, corruptRule.strategy, true);
        } else {
          const corrupted = corruptBinaryPayload(payload as ArrayBuffer | ArrayBufferView | Blob, corruptRule.strategy);
          if (corrupted === null) {
            emitCorrupt(emitter, url, direction, payloadType, corruptRule.strategy, false, 'incompatible-payload-type');
          } else {
            payload = corrupted;
            wasCorrupted = true;
            emitCorrupt(emitter, url, direction, payloadType, corruptRule.strategy, true);
          }
        }
      }

      const delayRule = findFiringRule<WebSocketDelayConfig>(config.delays, url, direction, random, counters, groups, emitter, getParsedUrl);
      if (delayRule) {
        msgEvt.stopImmediatePropagation();
        emitDelay(emitter, url, direction, payloadType, delayRule.delayMs);
        const timer: PendingDelayTimer = {
        kind: 'delay',
        handle: setTimeout(() => {
          untrackTimer(socket, timer);
          if (!running) return;
          redispatch(socket, msgEvt, payload);
        }, delayRule.delayMs),
          url, direction, payloadType,
        };
        trackTimer(socket, timer);
        return;
      }

      if (wasCorrupted) {
        msgEvt.stopImmediatePropagation();
        redispatch(socket, msgEvt, payload);
      }
    });
  };

  const scheduleCloseChaos = (socket: WebSocket, url: string): void => {
    if (!config.closes) return;
    let parsedCache: ParsedRequestUrl | null | undefined;
    const getParsedUrl = (): ParsedRequestUrl | null => {
      if (parsedCache === undefined) parsedCache = parseRequestUrl(url);
      return parsedCache;
    };
    for (const rule of config.closes) {
      emitter.debug('rule-evaluating', { url }, rule);
      // Close rules act on the connection, not on directional messages, so
      // there is no `direction` to filter on. Passing `direction: 'both'` plus
      // an actual `'inbound'` makes the shared `gateWsRule` direction check a
      // guaranteed pass while still reusing its urlPattern/hostname/queryParams
      // evaluation.
      const gate = gateWsRule(
        { urlPattern: rule.urlPattern, direction: 'both', hostname: rule.hostname, queryParams: rule.queryParams },
        url,
        'inbound',
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
      // Default to 1000 (Normal Closure)  -  the only 1xxx code browsers accept
      // as input to `socket.close(code)`. Reserved codes like 1006 throw
      // InvalidAccessError. Apps wanting a chaos-specific code should pass
      // something in the 4000–4999 range (e.g., `code: 4000`).
      const code = rule.code ?? 1000;
      const reason = rule.reason ?? 'Chaos Maker close';
      const afterMs = rule.afterMs ?? 0;

      const fire = () => {
        // If stop() ran between scheduling and firing, abandon the close so
        // the app socket survives intact.
        if (!running) return;
        clearSocketTimers(socket, 'close-interrupt');
        emitClose(emitter, url, code, reason);
        try {
          socket.close(code, reason);
        } catch {
          try { socket.close(); } catch { /* already closing */ }
        }
      };

      if (afterMs <= 0) {
        if (socket.readyState === socket.OPEN) {
          fire();
        } else {
          socket.addEventListener('open', fire, { once: true });
        }
      } else {
        const scheduleDeferred = () => {
          const timer: PendingCloseTimer = {
            kind: 'close',
            handle: setTimeout(fire, afterMs),
          };
          trackTimer(socket, timer);
        };
        if (socket.readyState === socket.OPEN) {
          scheduleDeferred();
        } else {
          socket.addEventListener('open', scheduleDeferred, { once: true });
        }
      }
      return; // one close rule per socket
    }
  };

  function ChaosWebSocket(this: unknown, url: string | URL, protocols?: string | string[]): WebSocket {
    const socket = new OriginalWebSocket(url, protocols);
    const urlStr = typeof url === 'string' ? url : url.toString();

    const boundOriginalSend = socket.send.bind(socket) as (
      d: string | ArrayBuffer | ArrayBufferView | Blob,
    ) => void;
    socket.send = function patchedSend(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
      const result = handleOutbound(socket, urlStr, data, boundOriginalSend);
      if (!result.handled) boundOriginalSend(result.data);
    };

    attachInboundListener(socket, urlStr);
    scheduleCloseChaos(socket, urlStr);

    return socket;
  }

  // `instanceof` compatibility + static constants.
  Object.defineProperty(ChaosWebSocket, 'prototype', {
    value: OriginalWebSocket.prototype,
    writable: false,
  });
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
    (ChaosWebSocket as unknown as Record<string, unknown>)[key] =
      (OriginalWebSocket as unknown as Record<string, unknown>)[key];
  }

  return {
    Wrapped: ChaosWebSocket as unknown as typeof WebSocket,
    uninstall(): void {
      // Disarm interception on every already-wrapped socket *before* clearing
      // timers so any listeners/fire callbacks that run during teardown also
      // bail out. Without this, existing sockets would keep applying chaos
      // indefinitely after ChaosMaker.stop().
      running = false;
      for (const [, timers] of pendingTimersBySocket) {
        for (const timer of timers) {
          clearTimeout(timer.handle);
          if (timer.kind === 'delay') {
            emitDrop(emitter, timer.url, timer.direction, timer.payloadType, 'stop-during-delay');
          }
        }
      }
      pendingTimersBySocket.clear();
    },
  };
}
