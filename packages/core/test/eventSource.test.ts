import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { patchEventSource, type EventSourceLikeStatic } from '../src/interceptors/eventSource';
import { ChaosEventEmitter } from '../src/events';
import { Logger } from '../src/debug';
import type { SSEConfig } from '../src/config';

// ---------------------------------------------------------------------------
// MockEventSource  -  minimal stand-in for the browser's EventSource. No real
// network. Tests drive inbound events with `simulateMessage(type?, data)`.
// ---------------------------------------------------------------------------
class MockEventSource extends EventTarget {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSED = 2 as const;

  CONNECTING = 0;
  OPEN = 1;
  CLOSED = 2;

  readyState: number = MockEventSource.CONNECTING;
  url: string;
  withCredentials: boolean;
  closed = false;

  constructor(url: string | URL, init?: EventSourceInit) {
    super();
    this.url = typeof url === 'string' ? url : url.toString();
    this.withCredentials = init?.withCredentials ?? false;
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
    this.closed = true;
  }

  simulateOpen(): void {
    this.readyState = MockEventSource.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  simulateMessage(data: string, type = 'message'): MessageEvent {
    const evt = new MessageEvent(type, { data });
    this.dispatchEvent(evt);
    return evt;
  }
}

function setupPatch(config: SSEConfig, random: () => number = () => 0) {
  const emitter = new ChaosEventEmitter();
  const counters = new Map<object, number>();
  const handle = patchEventSource(
    MockEventSource as unknown as EventSourceLikeStatic,
    config, emitter, random, counters,
  );
  type Ctor = new (url: string | URL, init?: EventSourceInit) => MockEventSource;
  const Wrapped = handle.Wrapped as unknown as Ctor;
  return { emitter, counters, handle, Wrapped };
}

const ALWAYS = () => 0;
const NEVER = () => 0.99;

describe('patchEventSource  -  wrapper constructor', () => {
  it('returns a real MockEventSource (instanceof compatibility)', () => {
    const { Wrapped } = setupPatch({});
    const es = new Wrapped('http://test/sse');
    expect(es).toBeInstanceOf(MockEventSource);
  });

  it('passes through unmatched messages untouched', () => {
    const { Wrapped } = setupPatch({
      drops: [{ urlPattern: '/other', probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    es.simulateMessage('payload');
    expect(received).toEqual(['payload']);
  });
});

describe('drop chaos', () => {
  it('drops messages matching the rule', () => {
    const { emitter, Wrapped } = setupPatch({
      drops: [{ urlPattern: '/sse', probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    es.simulateMessage('a');
    es.simulateMessage('b');
    expect(received).toEqual([]);
    const drops = emitter.getLog().filter(e => e.type === 'sse:drop');
    expect(drops.length).toBe(2);
    expect(drops.every(e => e.applied)).toBe(true);
  });

  it('does not drop when probability roll fails', () => {
    const { Wrapped } = setupPatch({
      drops: [{ urlPattern: '/sse', probability: 0.1 }],
    }, NEVER);
    const es = new Wrapped('http://test/sse');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    es.simulateMessage('ok');
    expect(received).toEqual(['ok']);
  });

  it('eventType filter matches only the named event', () => {
    const { Wrapped, emitter } = setupPatch({
      drops: [{ urlPattern: '/sse', eventType: 'tick', probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    const tickReceived: unknown[] = [];
    const msgReceived: unknown[] = [];
    es.addEventListener('tick', (e) => tickReceived.push((e as MessageEvent).data));
    es.addEventListener('message', (e) => msgReceived.push((e as MessageEvent).data));
    es.simulateMessage('1', 'tick');
    es.simulateMessage('2', 'message');
    expect(tickReceived).toEqual([]);
    expect(msgReceived).toEqual(['2']);
    const drops = emitter.getLog().filter(e => e.type === 'sse:drop');
    expect(drops.length).toBe(1);
    expect(drops[0].detail.eventType).toBe('tick');
  });

  it("'*' eventType matches every event regardless of name", () => {
    const { Wrapped, emitter } = setupPatch({
      drops: [{ urlPattern: '/sse', eventType: '*', probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    es.addEventListener('tick', () => undefined);
    es.simulateMessage('a');
    es.simulateMessage('b', 'tick');
    expect(emitter.getLog().filter(e => e.type === 'sse:drop').length).toBe(2);
  });
});

describe('delay chaos', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('defers dispatch by delayMs', () => {
    const { Wrapped } = setupPatch({
      delays: [{ urlPattern: '/sse', delayMs: 200, probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    es.simulateMessage('late');
    expect(received).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(received).toEqual(['late']);
  });

  it('emits sse:delay event when scheduled', () => {
    const { Wrapped, emitter } = setupPatch({
      delays: [{ urlPattern: '/sse', delayMs: 100, probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    es.simulateMessage('x');
    const delays = emitter.getLog().filter(e => e.type === 'sse:delay');
    expect(delays.length).toBe(1);
    expect(delays[0].detail.delayMs).toBe(100);
  });
});

describe('corrupt chaos', () => {
  it.each([
    ['truncate', 'hello world', 'hello'],
    ['empty', 'hello', ''],
  ] as const)('%s mutates inbound text', (strategy, input, expected) => {
    const { Wrapped } = setupPatch({
      corruptions: [{ urlPattern: '/sse', strategy, probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    es.simulateMessage(input);
    expect(received).toEqual([expected]);
  });

  it('malformed-json appends garbage', () => {
    const { Wrapped } = setupPatch({
      corruptions: [{ urlPattern: '/sse', strategy: 'malformed-json', probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    const received: string[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data as string));
    es.simulateMessage('{"a":1}');
    expect(received[0]).toContain('{"a":1}');
    expect(received[0]).not.toBe('{"a":1}');
  });

  it('emits sse:corrupt event with strategy', () => {
    const { Wrapped, emitter } = setupPatch({
      corruptions: [{ urlPattern: '/sse', strategy: 'empty', probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    es.simulateMessage('payload');
    const corrupted = emitter.getLog().filter(e => e.type === 'sse:corrupt');
    expect(corrupted.length).toBe(1);
    expect(corrupted[0].detail.strategy).toBe('empty');
  });
});

describe('close chaos', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('closes the source after afterMs and emits sse:close', () => {
    const { Wrapped, emitter } = setupPatch({
      closes: [{ urlPattern: '/sse', probability: 1, afterMs: 1000 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    let errorSeen = false;
    let readyStateAtError = -1;
    es.addEventListener('error', () => {
      errorSeen = true;
      readyStateAtError = es.readyState;
    });
    expect(es.closed).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(errorSeen).toBe(true);
    expect(es.closed).toBe(true);
    // SSE spec compliance: readyState must already be CLOSED when onerror fires
    // for a permanently-failed connection.
    expect(readyStateAtError).toBe(MockEventSource.CLOSED);
    const closes = emitter.getLog().filter(e => e.type === 'sse:close');
    expect(closes.length).toBe(1);
  });

  it('afterMs=0 closes on next tick (still after constructor)', () => {
    const { Wrapped } = setupPatch({
      closes: [{ urlPattern: '/sse', probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    expect(es.closed).toBe(false);
    vi.advanceTimersByTime(0);
    expect(es.closed).toBe(true);
  });
});

describe('counting (onNth / everyNth / afterN)', () => {
  it('onNth fires exactly once on the Nth message', () => {
    const { Wrapped, emitter } = setupPatch({
      drops: [{ urlPattern: '/sse', probability: 1, onNth: 3 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    for (let i = 1; i <= 5; i++) es.simulateMessage(`m${i}`);
    expect(received).toEqual(['m1', 'm2', 'm4', 'm5']);
    expect(emitter.getLog().filter(e => e.type === 'sse:drop').length).toBe(1);
  });

  it('everyNth fires on multiples of N', () => {
    const { Wrapped, emitter } = setupPatch({
      drops: [{ urlPattern: '/sse', probability: 1, everyNth: 2 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    for (let i = 1; i <= 4; i++) es.simulateMessage(`m${i}`);
    expect(emitter.getLog().filter(e => e.type === 'sse:drop').length).toBe(2);
  });
});

describe('user-initiated close while a delay is pending', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('does not redispatch a delayed message after source.close()', () => {
    const { Wrapped } = setupPatch({
      delays: [{ urlPattern: '/sse', delayMs: 500, probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    es.simulateMessage('queued');
    // App closes while delay timer is still pending.
    es.close();
    vi.advanceTimersByTime(500);
    expect(received).toEqual([]);
  });
});

describe('uninstall', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('cancels pending delay timers and emits stop-during-delay drops', () => {
    const { Wrapped, emitter, handle } = setupPatch({
      delays: [{ urlPattern: '/sse', delayMs: 1000, probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    es.simulateMessage('queued');
    handle.uninstall();
    vi.advanceTimersByTime(2000);
    expect(received).toEqual([]);
    const drops = emitter.getLog().filter(e => e.type === 'sse:drop');
    expect(drops.length).toBe(1);
    expect(drops[0].detail.reason).toBe('stop-during-delay');
  });

  it('after uninstall, new messages on a wrapped source pass through', () => {
    const { Wrapped, handle } = setupPatch({
      drops: [{ urlPattern: '/sse', probability: 1 }],
    }, ALWAYS);
    const es = new Wrapped('http://test/sse');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    handle.uninstall();
    es.simulateMessage('after-stop');
    expect(received).toEqual(['after-stop']);
  });
});

describe('hostname and queryParams matchers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hostname inline fires on matching host and skips on mismatch', () => {
    const cfg: SSEConfig = {
      drops: [
        {
          urlPattern: '*',
          hostname: 'sse.example.com',
          probability: 1,
        } as never,
      ],
    };
    const { Wrapped } = setupPatch(cfg, ALWAYS);
    const matching = new Wrapped('http://sse.example.com/feed');
    const matched: unknown[] = [];
    matching.addEventListener('message', (e) => matched.push((e as MessageEvent).data));
    matching.simulateMessage('a');
    expect(matched).toEqual([]);

    const other = new Wrapped('http://other.example.com/feed');
    const otherReceived: unknown[] = [];
    other.addEventListener('message', (e) => otherReceived.push((e as MessageEvent).data));
    other.simulateMessage('b');
    expect(otherReceived).toEqual(['b']);
  });

  it('queryParams inline fires for ?topic=alerts and skips for ?topic=quotes', () => {
    const cfg: SSEConfig = {
      drops: [
        {
          urlPattern: '*',
          queryParams: { topic: 'alerts' },
          probability: 1,
        } as never,
      ],
    };
    const { Wrapped } = setupPatch(cfg, ALWAYS);
    const alerts = new Wrapped('http://sse.example.com/feed?topic=alerts');
    const alertsReceived: unknown[] = [];
    alerts.addEventListener('message', (e) => alertsReceived.push((e as MessageEvent).data));
    alerts.simulateMessage('a');
    expect(alertsReceived).toEqual([]);

    const quotes = new Wrapped('http://sse.example.com/feed?topic=quotes');
    const quotesReceived: unknown[] = [];
    quotes.addEventListener('message', (e) => quotesReceived.push((e as MessageEvent).data));
    quotes.simulateMessage('q');
    expect(quotesReceived).toEqual(['q']);
  });

  it('counter does not increment on hostname mismatch', () => {
    const cfg: SSEConfig = {
      drops: [
        {
          urlPattern: '*',
          hostname: 'sse.example.com',
          probability: 1,
          onNth: 1,
        } as never,
      ],
    };
    const { Wrapped } = setupPatch(cfg, ALWAYS);
    const miss = new Wrapped('http://other.example.com/feed');
    const missReceived: unknown[] = [];
    miss.addEventListener('message', (e) => missReceived.push((e as MessageEvent).data));
    miss.simulateMessage('m');
    expect(missReceived).toEqual(['m']);

    const hit = new Wrapped('http://sse.example.com/feed');
    const hitReceived: unknown[] = [];
    hit.addEventListener('message', (e) => hitReceived.push((e as MessageEvent).data));
    hit.simulateMessage('h');
    expect(hitReceived).toEqual([]);
  });

  it('debug stream carries skippedAt and matchedBy when hostname matters', () => {
    const cfg: SSEConfig = {
      drops: [
        {
          urlPattern: '*',
          hostname: 'sse.example.com',
          probability: 1,
        } as never,
      ],
    };
    const emitter = new ChaosEventEmitter();
    emitter.setLogger(new Logger({ enabled: true }));
    // Restored by the suite-level afterEach so the mock does not leak.
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const counters = new Map<object, number>();
    const handle = patchEventSource(
      MockEventSource as unknown as EventSourceLikeStatic,
      cfg, emitter, ALWAYS, counters,
    );
    type Ctor = new (url: string | URL, init?: EventSourceInit) => MockEventSource;
    const Wrapped = handle.Wrapped as unknown as Ctor;

    new Wrapped('http://other.example.com/feed').simulateMessage('miss');
    new Wrapped('http://sse.example.com/feed').simulateMessage('hit');

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
