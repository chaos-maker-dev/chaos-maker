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
import { resolveReplay, type ReplayPlan } from '../ai/replay';
import { shouldApplyChaos, matchUrl, incrementCounter, checkCountingCondition, gateGroup } from '../utils';
import {
  parseRequestUrl,
  matchHostname,
  matchQueryParams,
  type ParsedRequestUrl,
} from '../matchers';
import type { RuleGroupRegistry } from '../groups';
import type { StreamCancelRegistry } from './streamCancelRegistry';

type Direction = 'inbound' | 'outbound';
type PayloadType = 'text' | 'binary';

const INTERCEPT_MARKER = Symbol.for('chaos-maker.websocket.intercepted');

interface PendingDelayTimer {
  kind: 'delay';
  handle: ReturnType<typeof setTimeout>;
  url: string;
  direction: Direction;
  payloadType: PayloadType;
  connectionId?: string;
  chunkIndex?: number;
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

interface InboundLifecycle {
  connectionId?: string;
  chunkIndex?: number;
}

function emitDrop(
  emitter: ChaosEventEmitter,
  url: string,
  direction: Direction,
  payloadType: PayloadType,
  reason?: string,
  lifecycle?: InboundLifecycle,
): void {
  emitter.emit({
    type: 'websocket:drop',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url,
      direction,
      payloadType,
      ...(reason ? { reason } : {}),
      ...(lifecycle?.connectionId !== undefined ? { connectionId: lifecycle.connectionId } : {}),
      ...(lifecycle?.chunkIndex !== undefined ? { chunkIndex: lifecycle.chunkIndex } : {}),
    },
  });
}

function emitDelay(
  emitter: ChaosEventEmitter,
  url: string,
  direction: Direction,
  payloadType: PayloadType,
  delayMs: number,
  lifecycle?: InboundLifecycle,
): void {
  emitter.emit({
    type: 'websocket:delay',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url,
      direction,
      payloadType,
      delayMs,
      ...(lifecycle?.connectionId !== undefined ? { connectionId: lifecycle.connectionId } : {}),
      ...(lifecycle?.chunkIndex !== undefined ? { chunkIndex: lifecycle.chunkIndex } : {}),
      ...(direction === 'inbound' ? { phase: 'ai:stream-paused' as const } : {}),
    },
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
  lifecycle?: InboundLifecycle,
): void {
  emitter.emit({
    type: 'websocket:corrupt',
    timestamp: Date.now(),
    applied,
    detail: {
      url,
      direction,
      payloadType,
      strategy,
      ...(reason ? { reason } : {}),
      ...(lifecycle?.connectionId !== undefined ? { connectionId: lifecycle.connectionId } : {}),
      ...(lifecycle?.chunkIndex !== undefined ? { chunkIndex: lifecycle.chunkIndex } : {}),
    },
  });
}

function emitClose(
  emitter: ChaosEventEmitter,
  url: string,
  code: number,
  reason: string,
  lifecycle?: InboundLifecycle,
): void {
  emitter.emit({
    type: 'websocket:close',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url,
      closeCode: code,
      closeReason: reason,
      ...(lifecycle?.connectionId !== undefined ? { connectionId: lifecycle.connectionId } : {}),
      phase: 'ai:stream-truncated' as const,
    },
  });
}

function emitFirstInboundChunkMarker(emitter: ChaosEventEmitter, url: string, lifecycle: InboundLifecycle): void {
  emitter.emit({
    type: 'websocket:lifecycle',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url,
      direction: 'inbound',
      connectionId: lifecycle.connectionId,
      chunkIndex: 0,
      phase: 'ai:first-chunk',
    },
  });
}

function emitStreamResumedMarker(emitter: ChaosEventEmitter, url: string, lifecycle: InboundLifecycle): void {
  emitter.emit({
    type: 'websocket:lifecycle',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url,
      direction: 'inbound',
      connectionId: lifecycle.connectionId,
      chunkIndex: lifecycle.chunkIndex,
      phase: 'ai:stream-resumed',
    },
  });
}

function emitReplayStarted(emitter: ChaosEventEmitter, url: string, lifecycle: InboundLifecycle): void {
  emitter.emit({
    type: 'websocket:lifecycle',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url,
      direction: 'inbound',
      connectionId: lifecycle.connectionId,
      chunkIndex: 0,
      phase: 'ai:stream-replayed',
    },
  });
}

function emitReplayDuplicate(emitter: ChaosEventEmitter, url: string, lifecycle: InboundLifecycle): void {
  emitter.emit({
    type: 'websocket:lifecycle',
    timestamp: Date.now(),
    applied: true,
    detail: {
      url,
      direction: 'inbound',
      connectionId: lifecycle.connectionId,
      chunkIndex: lifecycle.chunkIndex,
      phase: 'ai:chunk-duplicated',
    },
  });
}

let _wsConnectionCounter = 0;
function mintConnectionId(): string {
  const c = (typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined);
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // fall through
    }
  }
  _wsConnectionCounter += 1;
  return `chaos-ws-${_wsConnectionCounter}`;
}

export function patchWebSocket(
  OriginalWebSocket: typeof WebSocket,
  config: WebSocketConfig,
  emitter: ChaosEventEmitter,
  random: () => number,
  counters: Map<object, number>,
  groups?: RuleGroupRegistry,
  /** Present when the user-interaction cancel trigger is armed. Every wrapped
   *  socket registers a cancel hook that closes it (the app observes a normal
   *  `close` event, as if the user tore the connection down). */
  cancelRegistry?: StreamCancelRegistry,
): WebSocketPatchHandle {
  const pendingTimersBySocket = new Map<WebSocket, Set<PendingTimer>>();
  const inboundContextBySocket = new WeakMap<
    WebSocket,
    { connectionId: string; chunkIndex: number; replaying?: boolean }
  >();
  // Set to false in uninstall() so that already-wrapped sockets stop applying
  // chaos on any subsequent message / scheduled close after ChaosMaker.stop().
  let running = true;

  // Resolve the replay plan once; the same immutable plan drives every matched
  // socket.
  const replayPlan: ReplayPlan | null = config.replay
    ? resolveReplay(config.replay.data, config.replay.mutations)
    : null;

  const trackTimer = (socket: WebSocket, timer: PendingTimer): void => {
    let set = pendingTimersBySocket.get(socket);
    if (!set) {
      set = new Set();
      pendingTimersBySocket.set(socket, set);
    }
    set.add(timer);
  };

  const untrackTimer = (socket: WebSocket, timer: PendingTimer): void => {
    const set = pendingTimersBySocket.get(socket);
    if (!set) return;
    set.delete(timer);
    if (set.size === 0) {
      pendingTimersBySocket.delete(socket);
    }
  };

  const clearSocketTimers = (socket: WebSocket, reason: string): void => {
    const set = pendingTimersBySocket.get(socket);
    if (!set) return;
    for (const timer of set) {
      clearTimeout(timer.handle);
      // Only pending delays were observable as a "message in flight"; close
      // timers haven't emitted anything yet, so cancelling them is silent.
      if (timer.kind === 'delay') {
        emitDrop(
          emitter,
          timer.url,
          timer.direction,
          timer.payloadType,
          reason,
          timer.direction === 'inbound'
            ? { connectionId: timer.connectionId, chunkIndex: timer.chunkIndex }
            : undefined,
        );
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

      const ctx = inboundContextBySocket.get(socket);
      if (!ctx) return; // wrapper was uninstalled between dispatch + capture
      // Replay owns this socket: swallow every real inbound message so the app
      // sees only the fixture-driven messages.
      if (ctx.replaying) {
        msgEvt.stopImmediatePropagation();
        return;
      }
      ctx.chunkIndex += 1;
      const lifecycle: InboundLifecycle = {
        connectionId: ctx.connectionId,
        chunkIndex: ctx.chunkIndex,
      };
      if (ctx.chunkIndex === 0) {
        emitFirstInboundChunkMarker(emitter, url, lifecycle);
      }

      const direction: Direction = 'inbound';
      const payloadType = getPayloadType(msgEvt.data);
      let parsedCache: ParsedRequestUrl | null | undefined;
      const getParsedUrl = (): ParsedRequestUrl | null => {
        if (parsedCache === undefined) parsedCache = parseRequestUrl(url);
        return parsedCache;
      };

      if (findFiringRule<WebSocketDropConfig>(config.drops, url, direction, random, counters, groups, emitter, getParsedUrl)) {
        msgEvt.stopImmediatePropagation();
        emitDrop(emitter, url, direction, payloadType, undefined, lifecycle);
        return;
      }

      let payload: unknown = msgEvt.data;
      let wasCorrupted = false;
      const corruptRule = findFiringRule<WebSocketCorruptConfig>(config.corruptions, url, direction, random, counters, groups, emitter, getParsedUrl);
      if (corruptRule) {
        if (payloadType === 'text') {
          payload = corruptTextPayload(payload as string, corruptRule.strategy);
          wasCorrupted = true;
          emitCorrupt(emitter, url, direction, payloadType, corruptRule.strategy, true, undefined, lifecycle);
        } else {
          const corrupted = corruptBinaryPayload(payload as ArrayBuffer | ArrayBufferView | Blob, corruptRule.strategy);
          if (corrupted === null) {
            emitCorrupt(emitter, url, direction, payloadType, corruptRule.strategy, false, 'incompatible-payload-type', lifecycle);
          } else {
            payload = corrupted;
            wasCorrupted = true;
            emitCorrupt(emitter, url, direction, payloadType, corruptRule.strategy, true, undefined, lifecycle);
          }
        }
      }

      const delayRule = findFiringRule<WebSocketDelayConfig>(config.delays, url, direction, random, counters, groups, emitter, getParsedUrl);
      if (delayRule) {
        msgEvt.stopImmediatePropagation();
        emitDelay(emitter, url, direction, payloadType, delayRule.delayMs, lifecycle);
        const delayedChunkIndex = ctx.chunkIndex;
        const timer: PendingDelayTimer = {
        kind: 'delay',
        handle: setTimeout(() => {
          untrackTimer(socket, timer);
          if (!running) return;
          // Bail if the app drove the socket to CLOSED between the delay
          // scheduling and the timer firing; otherwise the redispatch
          // produces a ghost inbound `message` event past close.
          if (socket.readyState === socket.CLOSED) return;
          emitStreamResumedMarker(emitter, url, { connectionId: ctx.connectionId, chunkIndex: delayedChunkIndex });
          redispatch(socket, msgEvt, payload);
        }, delayRule.delayMs),
          url, direction, payloadType,
          connectionId: ctx.connectionId,
          chunkIndex: delayedChunkIndex,
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
        const ctx = inboundContextBySocket.get(socket);
        emitClose(emitter, url, code, reason, ctx ? { connectionId: ctx.connectionId } : undefined);
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

  const dispatchSyntheticInbound = (socket: WebSocket, data: string): void => {
    const ev = new MessageEvent('message', { data });
    (ev as unknown as Record<symbol, unknown>)[INTERCEPT_MARKER] = true;
    socket.dispatchEvent(ev);
  };

  const scheduleReplay = (socket: WebSocket, url: string): void => {
    if (!config.replay || !replayPlan) return;
    const directive = config.replay as {
      urlPattern?: string;
      hostname?: HostnameMatcher;
      queryParams?: Record<string, RequestKvMatcher>;
    };
    let parsedCache: ParsedRequestUrl | null | undefined;
    const getParsedUrl = (): ParsedRequestUrl | null => {
      if (parsedCache === undefined) parsedCache = parseRequestUrl(url);
      return parsedCache;
    };
    const gate = gateWsRule(
      { urlPattern: directive.urlPattern, direction: 'both', hostname: directive.hostname, queryParams: directive.queryParams },
      url,
      'inbound',
      getParsedUrl,
    );
    if (!gate.proceed) return;
    const ctx = inboundContextBySocket.get(socket);
    if (!ctx) return;
    ctx.replaying = true;
    emitReplayStarted(emitter, url, { connectionId: ctx.connectionId });

    const plan = replayPlan;
    const dispatchAll = (): void => {
      // `uninstall()` may have run while waiting for the socket to open; the
      // `{ once: true }` open listener can still fire, so bail before scheduling.
      if (!running) return;
      plan.pieces.forEach((piece, i) => {
        const timer: PendingReplayTimer = {
          kind: 'replay',
          handle: setTimeout(() => {
            untrackTimer(socket, timer);
            if (!running) return;
            if (socket.readyState === socket.CLOSED) return;
            if (i === 0) emitFirstInboundChunkMarker(emitter, url, { connectionId: ctx.connectionId, chunkIndex: 0 });
            dispatchSyntheticInbound(socket, piece.text);
            if (piece.kind === 'duplicate') {
              emitReplayDuplicate(emitter, url, { connectionId: ctx.connectionId, chunkIndex: piece.sourceIndex });
            }
          }, piece.emitAtMs),
        };
        trackTimer(socket, timer);
      });

      if (plan.truncated) {
        const lastAtMs = plan.pieces.reduce((max, p) => Math.max(max, p.emitAtMs), 0);
        const lastSourceIndex = plan.pieces.length ? plan.pieces[plan.pieces.length - 1].sourceIndex : -1;
        const timer: PendingReplayTimer = {
          kind: 'replay',
          handle: setTimeout(() => {
            untrackTimer(socket, timer);
            if (!running) return;
            if (socket.readyState === socket.CLOSED) return;
            emitClose(emitter, url, 1000, 'replay-truncate', { connectionId: ctx.connectionId, chunkIndex: lastSourceIndex });
            try {
              socket.close(1000, 'replay-truncate');
            } catch {
              try {
                socket.close();
              } catch {
                // already closing
              }
            }
          }, lastAtMs),
        };
        trackTimer(socket, timer);
      }
    };

    // Fixture timing is relative to stream start; anchor it to the socket open
    // so offsets line up with a real connection lifecycle.
    if (socket.readyState === socket.OPEN) {
      dispatchAll();
    } else {
      socket.addEventListener('open', dispatchAll, { once: true });
    }
  };

  function ChaosWebSocket(this: unknown, url: string | URL, protocols?: string | string[]): WebSocket {
    const socket = new OriginalWebSocket(url, protocols);
    const urlStr = typeof url === 'string' ? url : url.toString();
    const ctx = { connectionId: mintConnectionId(), chunkIndex: -1 };
    inboundContextBySocket.set(socket, ctx);

    if (cancelRegistry) {
      cancelRegistry.register({
        transport: 'websocket',
        url: urlStr,
        connectionId: ctx.connectionId,
        cancel: () => {
          if (socket.readyState === socket.CLOSING || socket.readyState === socket.CLOSED) {
            return false;
          }
          clearSocketTimers(socket, 'user-cancel');
          try {
            socket.close();
          } catch {
            return false;
          }
          return true;
        },
      });
    }

    const boundOriginalSend = socket.send.bind(socket) as (
      d: string | ArrayBuffer | ArrayBufferView | Blob,
    ) => void;
    socket.send = function patchedSend(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
      const result = handleOutbound(socket, urlStr, data, boundOriginalSend);
      if (!result.handled) boundOriginalSend(result.data);
    };

    attachInboundListener(socket, urlStr);
    scheduleReplay(socket, urlStr);
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
            emitDrop(
              emitter,
              timer.url,
              timer.direction,
              timer.payloadType,
              'stop-during-delay',
              timer.direction === 'inbound'
                ? { connectionId: timer.connectionId, chunkIndex: timer.chunkIndex }
                : undefined,
            );
          }
        }
      }
      pendingTimersBySocket.clear();
    },
  };
}
