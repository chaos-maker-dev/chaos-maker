import { describe, it, expect } from 'vitest';
import { patchEventSource, type EventSourceLikeStatic } from '../src/interceptors/eventSource';
import { patchWebSocket } from '../src/interceptors/websocket';
import { ChaosEventEmitter } from '../src/events';
import type { SSEConfig, WebSocketConfig, ReplayFixture } from '../src/config';

function fixture(overrides: Partial<ReplayFixture> = {}): ReplayFixture {
  return {
    version: 1,
    transport: 'fetch-stream',
    chunks: [
      { offsetMs: 0, data: 'R1' },
      { offsetMs: 0, data: 'R2' },
      { offsetMs: 0, data: 'R3' },
    ],
    ...overrides,
  };
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- SSE mock -------------------------------------------------------------
class MockEventSource extends EventTarget {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSED = 2 as const;
  CONNECTING = 0;
  OPEN = 1;
  CLOSED = 2;
  readyState = MockEventSource.CONNECTING;
  url: string;
  constructor(url: string | URL) {
    super();
    this.url = typeof url === 'string' ? url : url.toString();
  }
  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }
  simulateMessage(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function setupSse(config: SSEConfig) {
  const emitter = new ChaosEventEmitter();
  const handle = patchEventSource(
    MockEventSource as unknown as EventSourceLikeStatic,
    config,
    emitter,
    () => 0,
    new Map(),
  );
  const Wrapped = handle.Wrapped as unknown as new (url: string) => MockEventSource;
  return { emitter, Wrapped };
}

// --- WebSocket mock -------------------------------------------------------
class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  url: string;
  constructor(url: string | URL) {
    super();
    this.url = typeof url === 'string' ? url : url.toString();
  }
  send(): void {}
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  simulateMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function setupWs(config: WebSocketConfig) {
  const emitter = new ChaosEventEmitter();
  const handle = patchWebSocket(
    MockWebSocket as unknown as typeof WebSocket,
    config,
    emitter,
    () => 0,
    new Map(),
  );
  const Wrapped = handle.Wrapped as unknown as new (url: string) => MockWebSocket;
  return { emitter, Wrapped };
}

describe('SSE replay', () => {
  it('drives fixture messages and suppresses real inbound events', async () => {
    const { emitter, Wrapped } = setupSse({ replay: { urlPattern: '/sse', data: fixture() } });
    const es = new Wrapped('http://test/sse');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    es.simulateMessage('REAL'); // suppressed: replay owns the source
    await tick();
    expect(received).toEqual(['R1', 'R2', 'R3']);
    const log = emitter.getLog();
    expect(log.some((e) => e.detail.phase === 'ai:stream-replayed')).toBe(true);
    expect(log.some((e) => e.detail.phase === 'ai:first-chunk')).toBe(true);
  });

  it('truncates and surfaces ai:stream-truncated', async () => {
    const { emitter, Wrapped } = setupSse({
      replay: { urlPattern: '/sse', data: fixture(), mutations: [{ type: 'truncate', afterChunk: 1 }] },
    });
    const es = new Wrapped('http://test/sse');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    await tick();
    expect(received).toEqual(['R1', 'R2']);
    expect(emitter.getLog().some((e) => e.detail.phase === 'ai:stream-truncated')).toBe(true);
  });

  it('duplicates a chunk and surfaces ai:chunk-duplicated', async () => {
    const { emitter, Wrapped } = setupSse({
      replay: { urlPattern: '/sse', data: fixture(), mutations: [{ type: 'duplicate', chunkIndex: 0 }] },
    });
    const es = new Wrapped('http://test/sse');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    await tick();
    expect(received).toEqual(['R1', 'R1', 'R2', 'R3']);
    expect(emitter.getLog().some((e) => e.detail.phase === 'ai:chunk-duplicated')).toBe(true);
  });

  it('leaves non-matching sources alone', async () => {
    const { Wrapped } = setupSse({ replay: { urlPattern: '/sse', data: fixture() } });
    const es = new Wrapped('http://test/other');
    const received: unknown[] = [];
    es.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    es.simulateMessage('REAL');
    await tick();
    expect(received).toEqual(['REAL']);
  });
});

describe('WebSocket replay', () => {
  it('drives fixture messages after open and suppresses real inbound', async () => {
    const { emitter, Wrapped } = setupWs({ replay: { urlPattern: '/ws', data: fixture() } });
    const socket = new Wrapped('ws://test/ws');
    const received: unknown[] = [];
    socket.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    socket.simulateMessage('REAL'); // suppressed
    socket.simulateOpen();
    await tick();
    expect(received).toEqual(['R1', 'R2', 'R3']);
    expect(emitter.getLog().some((e) => e.detail.phase === 'ai:stream-replayed')).toBe(true);
  });

  it('truncates and surfaces ai:stream-truncated', async () => {
    const { emitter, Wrapped } = setupWs({
      replay: { urlPattern: '/ws', data: fixture(), mutations: [{ type: 'truncate', afterChunk: 0 }] },
    });
    const socket = new Wrapped('ws://test/ws');
    const received: unknown[] = [];
    socket.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    socket.simulateOpen();
    await tick();
    expect(received).toEqual(['R1']);
    expect(emitter.getLog().some((e) => e.detail.phase === 'ai:stream-truncated')).toBe(true);
  });

  it('duplicates a chunk and surfaces ai:chunk-duplicated', async () => {
    const { emitter, Wrapped } = setupWs({
      replay: { urlPattern: '/ws', data: fixture(), mutations: [{ type: 'duplicate', chunkIndex: 1 }] },
    });
    const socket = new Wrapped('ws://test/ws');
    const received: unknown[] = [];
    socket.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    socket.simulateOpen();
    await tick();
    expect(received).toEqual(['R1', 'R2', 'R2', 'R3']);
    expect(emitter.getLog().some((e) => e.detail.phase === 'ai:chunk-duplicated')).toBe(true);
  });
});
