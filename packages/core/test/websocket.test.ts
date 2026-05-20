import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { patchWebSocket } from '../src/interceptors/websocket';
import { ChaosEventEmitter } from '../src/events';
import { Logger } from '../src/debug';
import type { WebSocketConfig } from '../src/config';

// ---------------------------------------------------------------------------
// MockWebSocket — minimal, deterministic stand-in for the browser's WebSocket.
// Does not actually open any connection. Tests drive inbound messages via
// `simulateMessage` and observe outbound messages via `sentMessages`.
// ---------------------------------------------------------------------------
class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
  url: string;
  sentMessages: unknown[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  constructor(url: string | URL, _protocols?: string | string[]) {
    super();
    this.url = typeof url === 'string' ? url : url.toString();
    void _protocols;
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.closedWith = { code, reason };
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  simulateMessage(data: unknown): MessageEvent {
    const evt = new MessageEvent('message', { data });
    this.dispatchEvent(evt);
    return evt;
  }
}

type WSCtor = new (url: string | URL, protocols?: string | string[]) => MockWebSocket;

function setupPatch(config: WebSocketConfig, random: () => number = () => 0) {
  const emitter = new ChaosEventEmitter();
  const counters = new Map<object, number>();
  const handle = patchWebSocket(
    MockWebSocket as unknown as typeof WebSocket,
    config, emitter, random, counters,
  );
  const Wrapped = handle.Wrapped as unknown as WSCtor;
  return { emitter, counters, handle, Wrapped };
}

// random() => 0 → probability always fires (Math.random() < probability).
const ALWAYS = () => 0;
// random() => 0.99 → probability never fires (unless p >= 1).
const NEVER = () => 0.99;

describe('patchWebSocket — wrapper constructor', () => {
  it('returns a real MockWebSocket instance (instanceof compatibility)', () => {
    const { Wrapped } = setupPatch({});
    const socket = new Wrapped('ws://test/api');
    expect(socket).toBeInstanceOf(MockWebSocket);
  });

  it('passes through send when no rules match the URL', () => {
    const { Wrapped } = setupPatch({
      drops: [{ urlPattern: '/other', direction: 'outbound', probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.send('hello');
    expect(socket.sentMessages).toEqual(['hello']);
  });

  it('passes inbound through when no rules match', () => {
    const { Wrapped } = setupPatch({});
    const socket = new Wrapped('ws://test/api');
    const received: unknown[] = [];
    socket.addEventListener('message', (evt) => {
      received.push((evt as MessageEvent).data);
    });
    socket.simulateMessage('hi');
    expect(received).toEqual(['hi']);
  });
});

describe('drop chaos', () => {
  it('drops outbound messages matching the rule', () => {
    const { emitter, Wrapped } = setupPatch({
      drops: [{ urlPattern: '/api', direction: 'outbound', probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.send('a');
    socket.send('b');
    expect(socket.sentMessages).toEqual([]);
    const drops = emitter.getLog().filter(e => e.type === 'websocket:drop');
    expect(drops.length).toBe(2);
    expect(drops.every(e => e.applied && e.detail.direction === 'outbound')).toBe(true);
  });

  it('drops inbound messages matching the rule', () => {
    const { emitter, Wrapped } = setupPatch({
      drops: [{ urlPattern: '/api', direction: 'inbound', probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    const received: unknown[] = [];
    socket.addEventListener('message', (evt) => received.push((evt as MessageEvent).data));
    socket.simulateMessage('payload');
    expect(received).toEqual([]);
    const drops = emitter.getLog().filter(e => e.type === 'websocket:drop');
    expect(drops.length).toBe(1);
    expect(drops[0].detail.direction).toBe('inbound');
  });

  it('does not drop when probability roll fails', () => {
    const { Wrapped } = setupPatch({
      drops: [{ urlPattern: '/api', direction: 'outbound', probability: 0.1 }],
    }, NEVER);
    const socket = new Wrapped('ws://test/api');
    socket.send('ok');
    expect(socket.sentMessages).toEqual(['ok']);
  });

  it('direction both fires on either direction independently', () => {
    const { emitter, Wrapped } = setupPatch({
      drops: [{ urlPattern: '/api', direction: 'both', probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    const received: unknown[] = [];
    socket.addEventListener('message', (evt) => received.push((evt as MessageEvent).data));
    socket.send('out');
    socket.simulateMessage('in');
    expect(socket.sentMessages).toEqual([]);
    expect(received).toEqual([]);
    expect(emitter.getLog().filter(e => e.type === 'websocket:drop').length).toBe(2);
  });
});

describe('delay chaos', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('defers outbound send by delayMs', () => {
    const { Wrapped } = setupPatch({
      delays: [{ urlPattern: '/api', direction: 'outbound', delayMs: 500, probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.send('hi');
    expect(socket.sentMessages).toEqual([]);
    vi.advanceTimersByTime(499);
    expect(socket.sentMessages).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(socket.sentMessages).toEqual(['hi']);
  });

  it('defers inbound dispatch by delayMs', () => {
    const { Wrapped } = setupPatch({
      delays: [{ urlPattern: '/api', direction: 'inbound', delayMs: 200, probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    const received: unknown[] = [];
    socket.addEventListener('message', (evt) => received.push((evt as MessageEvent).data));
    socket.simulateMessage('late');
    expect(received).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(received).toEqual(['late']);
  });

  it('re-dispatched message has the original origin and lastEventId', () => {
    const { Wrapped } = setupPatch({
      delays: [{ urlPattern: '/api', direction: 'inbound', delayMs: 100, probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    const received: MessageEvent[] = [];
    socket.addEventListener('message', (evt) => received.push(evt as MessageEvent));
    // Simulate a message; MessageEvent init defaults origin to ''
    socket.simulateMessage('x');
    vi.advanceTimersByTime(100);
    expect(received.length).toBe(1);
    expect(received[0].data).toBe('x');
  });
});

describe('corrupt chaos — text', () => {
  it.each([
    ['truncate', 'hello world', 'hello'], // half
    ['empty', 'hello', ''],
  ] as const)('%s mutates outbound text', (strategy, input, expected) => {
    const { emitter, Wrapped } = setupPatch({
      corruptions: [{ urlPattern: '/api', direction: 'outbound', strategy, probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.send(input);
    expect(socket.sentMessages).toEqual([expected]);
    const events = emitter.getLog().filter(e => e.type === 'websocket:corrupt');
    expect(events[0].applied).toBe(true);
    expect(events[0].detail.strategy).toBe(strategy);
  });

  it('malformed-json appends garbage', () => {
    const { Wrapped } = setupPatch({
      corruptions: [{ urlPattern: '/api', direction: 'outbound', strategy: 'malformed-json', probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.send('{"a":1}');
    expect(socket.sentMessages[0]).toContain('{"a":1}');
    expect(socket.sentMessages[0]).not.toBe('{"a":1}');
  });

  it('inbound corruption re-dispatches mutated payload', () => {
    const { Wrapped } = setupPatch({
      corruptions: [{ urlPattern: '/api', direction: 'inbound', strategy: 'empty', probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    const received: unknown[] = [];
    socket.addEventListener('message', (evt) => received.push((evt as MessageEvent).data));
    socket.simulateMessage('original');
    expect(received).toEqual(['']);
  });
});

describe('corrupt chaos — binary', () => {
  it('truncate halves an ArrayBuffer', () => {
    const { Wrapped } = setupPatch({
      corruptions: [{ urlPattern: '/api', direction: 'outbound', strategy: 'truncate', probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    const buf = new ArrayBuffer(8);
    socket.send(buf);
    const sent = socket.sentMessages[0] as ArrayBuffer;
    expect(sent.byteLength).toBe(4);
  });

  it('empty produces zero-length payload', () => {
    const { Wrapped } = setupPatch({
      corruptions: [{ urlPattern: '/api', direction: 'outbound', strategy: 'empty', probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.send(new Uint8Array([1, 2, 3, 4]));
    const sent = socket.sentMessages[0] as Uint8Array;
    expect(sent.byteLength).toBe(0);
  });

  it('malformed-json on binary emits applied:false with reason', () => {
    const { emitter, Wrapped } = setupPatch({
      corruptions: [{ urlPattern: '/api', direction: 'outbound', strategy: 'malformed-json', probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.send(new Uint8Array([1, 2]));
    // Binary payload passed through unchanged
    expect((socket.sentMessages[0] as Uint8Array).byteLength).toBe(2);
    const evt = emitter.getLog().find(e => e.type === 'websocket:corrupt');
    expect(evt?.applied).toBe(false);
    expect(evt?.detail.reason).toBe('incompatible-payload-type');
  });
});

describe('close chaos', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('closes the socket immediately on open when afterMs is 0', () => {
    const { emitter, Wrapped } = setupPatch({
      closes: [{ urlPattern: '/api', probability: 1, code: 4000, reason: 'chaos' }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.simulateOpen();
    expect(socket.closedWith).toEqual({ code: 4000, reason: 'chaos' });
    const closes = emitter.getLog().filter(e => e.type === 'websocket:close');
    expect(closes.length).toBe(1);
    expect(closes[0].detail.closeCode).toBe(4000);
  });

  it('closes after afterMs elapses from open', () => {
    const { Wrapped } = setupPatch({
      closes: [{ urlPattern: '/api', probability: 1, afterMs: 1000 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.simulateOpen();
    expect(socket.closedWith).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(socket.closedWith).not.toBeNull();
  });

  it('defaults to code 1000 (Normal Closure) and reason "Chaos Maker close"', () => {
    // 1000 is the only 1xxx code browsers accept as input to close(code);
    // 1006 (the previous default) is reserved and throws InvalidAccessError.
    const { emitter, Wrapped } = setupPatch({
      closes: [{ urlPattern: '/api', probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.simulateOpen();
    const closeEvt = emitter.getLog().find(e => e.type === 'websocket:close');
    expect(closeEvt?.detail.closeCode).toBe(1000);
    expect(closeEvt?.detail.closeReason).toBe('Chaos Maker close');
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'Chaos Maker close' });
  });
});

describe('counting', () => {
  it('onNth: 3 fires drop only on 3rd matching message', () => {
    const { Wrapped } = setupPatch({
      drops: [{ urlPattern: '/api', direction: 'outbound', probability: 1, onNth: 3 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.send('1'); socket.send('2'); socket.send('3'); socket.send('4');
    expect(socket.sentMessages).toEqual(['1', '2', '4']);
  });

  it('everyNth: 2 fires drop on 2nd, 4th, ...', () => {
    const { Wrapped } = setupPatch({
      drops: [{ urlPattern: '/api', direction: 'outbound', probability: 1, everyNth: 2 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    for (let i = 1; i <= 5; i++) socket.send(`m${i}`);
    expect(socket.sentMessages).toEqual(['m1', 'm3', 'm5']);
  });

  it('afterN: 2 fires drop from 3rd onward', () => {
    const { Wrapped } = setupPatch({
      drops: [{ urlPattern: '/api', direction: 'outbound', probability: 1, afterN: 2 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    for (let i = 1; i <= 4; i++) socket.send(`m${i}`);
    expect(socket.sentMessages).toEqual(['m1', 'm2']);
  });
});

describe('determinism', () => {
  it('identical seeds produce identical drop patterns', () => {
    // Use a real mulberry32-like deterministic sequence via counter.
    const seq = [0.1, 0.9, 0.2, 0.8, 0.3];
    const makeRandom = () => {
      let i = 0;
      return () => seq[i++ % seq.length];
    };
    const cfg: WebSocketConfig = {
      drops: [{ urlPattern: '/api', direction: 'outbound', probability: 0.5 }],
    };
    const run = (): string[] => {
      const emitter = new ChaosEventEmitter();
      const counters = new Map<object, number>();
      const handle = patchWebSocket(
        MockWebSocket as unknown as typeof WebSocket,
        cfg, emitter, makeRandom(), counters,
      );
      const Wrapped = handle.Wrapped as unknown as WSCtor;
      const socket = new Wrapped('ws://test/api');
      for (let i = 0; i < 5; i++) socket.send(`m${i}`);
      return emitter.getLog().filter(e => e.type === 'websocket:drop').map(e => String(e.detail.direction));
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });
});

describe('lifecycle — uninstall', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('clears pending delay timers and emits drop events', () => {
    const { emitter, handle, Wrapped } = setupPatch({
      delays: [{ urlPattern: '/api', direction: 'outbound', delayMs: 1000, probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.send('buffered');
    expect(socket.sentMessages).toEqual([]);
    handle.uninstall();
    // Timer should not fire after uninstall.
    vi.advanceTimersByTime(1000);
    expect(socket.sentMessages).toEqual([]);
    const drops = emitter.getLog().filter(
      e => e.type === 'websocket:drop' && e.detail.reason === 'stop-during-delay'
    );
    expect(drops.length).toBe(1);
  });

  it('disarms already-wrapped sockets so post-stop outbound messages pass through untouched', () => {
    const { emitter, handle, Wrapped } = setupPatch({
      drops: [{ urlPattern: '/api', direction: 'outbound', probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.simulateOpen();
    socket.send('before-stop'); // dropped
    expect(socket.sentMessages).toEqual([]);
    handle.uninstall();
    socket.send('after-stop'); // must pass through
    expect(socket.sentMessages).toEqual(['after-stop']);
    // No new drop event should be emitted after uninstall.
    const postStopDrops = emitter.getLog()
      .filter(e => e.type === 'websocket:drop' && !e.detail.reason);
    expect(postStopDrops.length).toBe(1); // only the pre-stop drop
  });

  it('disarms inbound interception after stop so listeners see raw messages', () => {
    const { handle, Wrapped } = setupPatch({
      drops: [{ urlPattern: '/api', direction: 'inbound', probability: 1 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    const received: unknown[] = [];
    socket.addEventListener('message', (evt) => received.push((evt as MessageEvent).data));
    socket.simulateMessage('blocked'); // dropped
    expect(received).toEqual([]);
    handle.uninstall();
    socket.simulateMessage('allowed'); // must pass through
    expect(received).toEqual(['allowed']);
  });

  it('cancels pending close timers silently (no phantom drop event)', () => {
    const { emitter, handle, Wrapped } = setupPatch({
      closes: [{ urlPattern: '/api', probability: 1, afterMs: 500 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.simulateOpen();
    handle.uninstall();
    vi.advanceTimersByTime(1000);
    // Socket must not be closed; no misleading drop event emitted.
    expect(socket.closedWith).toBeNull();
    const drops = emitter.getLog().filter(e => e.type === 'websocket:drop');
    expect(drops.length).toBe(0);
    const closes = emitter.getLog().filter(e => e.type === 'websocket:close');
    expect(closes.length).toBe(0);
  });
});

describe('close interrupts pending delays', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('clears delay timers when close-chaos fires', () => {
    const { emitter, Wrapped } = setupPatch({
      delays: [{ urlPattern: '/api', direction: 'outbound', delayMs: 5000, probability: 1 }],
      closes: [{ urlPattern: '/api', probability: 1, afterMs: 100 }],
    }, ALWAYS);
    const socket = new Wrapped('ws://test/api');
    socket.simulateOpen();
    socket.send('buffered');
    vi.advanceTimersByTime(100);
    // Close fired — pending send should never deliver.
    vi.advanceTimersByTime(5000);
    expect(socket.sentMessages).toEqual([]);
    const dropReasons = emitter.getLog()
      .filter(e => e.type === 'websocket:drop')
      .map(e => e.detail.reason);
    expect(dropReasons).toContain('close-interrupt');
  });
});

describe('hostname and queryParams matchers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hostname inline fires on matching host and skips on mismatch', () => {
    const cfg: WebSocketConfig = {
      drops: [
        {
          urlPattern: '*',
          direction: 'outbound',
          hostname: 'realtime.example.com',
          probability: 1,
        } as never,
      ],
    };
    const { Wrapped } = setupPatch(cfg, ALWAYS);
    const matching = new Wrapped('ws://realtime.example.com/api');
    matching.send('m1');
    expect(matching.sentMessages).toEqual([]);

    const nonMatching = new Wrapped('ws://other.example.com/api');
    nonMatching.send('m2');
    expect(nonMatching.sentMessages).toEqual(['m2']);
  });

  it('queryParams inline fires for ?room=alpha and skips for ?room=beta', () => {
    const cfg: WebSocketConfig = {
      drops: [
        {
          urlPattern: '*',
          direction: 'outbound',
          queryParams: { room: 'alpha' },
          probability: 1,
        } as never,
      ],
    };
    const { Wrapped } = setupPatch(cfg, ALWAYS);
    const alpha = new Wrapped('ws://test.example.com/api?room=alpha');
    alpha.send('a');
    expect(alpha.sentMessages).toEqual([]);

    const beta = new Wrapped('ws://test.example.com/api?room=beta');
    beta.send('b');
    expect(beta.sentMessages).toEqual(['b']);
  });

  it('counter does not increment on hostname mismatch', () => {
    const cfg: WebSocketConfig = {
      drops: [
        {
          urlPattern: '*',
          direction: 'outbound',
          hostname: 'realtime.example.com',
          probability: 1,
          onNth: 1,
        } as never,
      ],
    };
    const { Wrapped } = setupPatch(cfg, ALWAYS);
    // First send hits a non-matching host. If hostname mismatch incremented
    // the counter, the next matching send would not be the "1st matching"
    // request and onNth: 1 would no longer fire.
    new Wrapped('ws://other.example.com/api').send('miss');

    const matching = new Wrapped('ws://realtime.example.com/api');
    matching.send('hit');
    expect(matching.sentMessages).toEqual([]);
  });

  it('debug stream carries skippedAt and matchedBy when hostname matters', () => {
    const cfg: WebSocketConfig = {
      drops: [
        {
          urlPattern: '*',
          direction: 'outbound',
          hostname: 'realtime.example.com',
          probability: 1,
        } as never,
      ],
    };
    const emitter = new ChaosEventEmitter();
    emitter.setLogger(new Logger({ enabled: true }));
    // Restored by the suite-level afterEach so the mock does not leak.
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const counters = new Map<object, number>();
    const handle = patchWebSocket(
      MockWebSocket as unknown as typeof WebSocket,
      cfg, emitter, ALWAYS, counters,
    );
    const Wrapped = handle.Wrapped as unknown as WSCtor;

    new Wrapped('ws://other.example.com/api').send('miss');
    new Wrapped('ws://realtime.example.com/api').send('hit');

    const log = emitter.getLog();
    const skipped = log.find(
      (e) => e.type === 'debug' && e.detail.stage === 'rule-skip-match' && e.detail.skippedAt === 'hostname',
    );
    expect(skipped).toBeDefined();
    const matched = log.find(
      (e) => e.type === 'debug' && e.detail.stage === 'rule-matched' && Array.isArray(e.detail.matchedBy) && (e.detail.matchedBy as string[]).includes('hostname'),
    );
    expect(matched).toBeDefined();
  });
});
