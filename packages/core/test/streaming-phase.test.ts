import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChaosEventEmitter } from '../src/events';
import { patchFetchStream, type FetchStreamPatchHandle } from '../src/interceptors/networkFetchStream';
import { patchEventSource, type EventSourceLikeStatic, type EventSourcePatchHandle } from '../src/interceptors/eventSource';
import { patchWebSocket, type WebSocketPatchHandle } from '../src/interceptors/websocket';
import type { FetchStreamConfig, SSEConfig, WebSocketConfig } from '../src/config';

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

class StreamResponse {
  private readonly _stream: ReadableStream<Uint8Array> | null;
  constructor(stream: ReadableStream<Uint8Array> | null) {
    this._stream = stream;
  }
  get body(): ReadableStream<Uint8Array> | null {
    return this._stream;
  }
}

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const out: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(decoder.decode(value));
  }
  return out;
}

// ---------------------------------------------------------------------------
// fetch-stream phase emission
// ---------------------------------------------------------------------------

describe('fetch-stream phase emission', () => {
  let originalResponse: unknown;
  const handles: FetchStreamPatchHandle[] = [];

  beforeEach(() => {
    originalResponse = (globalThis as { Response?: unknown }).Response;
    vi.stubGlobal('Response', StreamResponse);
  });
  afterEach(() => {
    while (handles.length) handles.pop()!.uninstall();
    vi.stubGlobal('Response', originalResponse);
  });

  function setup(config: FetchStreamConfig, response: StreamResponse) {
    const emitter = new ChaosEventEmitter();
    const counters = new Map<object, number>();
    const originalFetch = vi.fn().mockResolvedValue(response);
    const handle = patchFetchStream(
      originalFetch as unknown as typeof fetch,
      config,
      () => 0,
      emitter,
      counters,
    );
    handles.push(handle);
    return { handle, emitter };
  }

  it('emits a fetch-stream:lifecycle event with phase ai:first-chunk on chunk 0', async () => {
    const { handle, emitter } = setup(
      { delays: [{ urlPattern: '*', delayMs: 0, probability: 1 }] },
      new StreamResponse(makeStream(['a', 'b'])),
    );
    const out = await handle.fetch('http://api/chat');
    await readAllText(out.body!);
    const lifecycle = emitter.getLog().filter((e) => e.type === 'fetch-stream:lifecycle');
    expect(lifecycle.length).toBeGreaterThanOrEqual(1);
    expect(lifecycle[0].detail.phase).toBe('ai:first-chunk');
    expect(lifecycle[0].detail.chunkIndex).toBe(0);
    expect(typeof lifecycle[0].detail.connectionId).toBe('string');
  });

  it('tags chunk-delayed events with phase ai:stream-paused and emits resumed marker', async () => {
    const { handle, emitter } = setup(
      { delays: [{ urlPattern: '*', delayMs: 5, probability: 1 }] },
      new StreamResponse(makeStream(['a'])),
    );
    const out = await handle.fetch('http://api/chat');
    await readAllText(out.body!);
    const delays = emitter.getLog().filter((e) => e.type === 'fetch-stream:chunk-delayed');
    const resumes = emitter.getLog().filter((e) => e.type === 'fetch-stream:lifecycle' && e.detail.phase === 'ai:stream-resumed');
    expect(delays.length).toBe(1);
    expect(delays[0].detail.phase).toBe('ai:stream-paused');
    expect(resumes.length).toBe(1);
  });

  it('tags chunk-duplicated events with phase ai:chunk-duplicated', async () => {
    const { handle, emitter } = setup(
      { corruptions: [{ urlPattern: '*', strategy: 'duplicate', probability: 1 }] },
      new StreamResponse(makeStream(['x'])),
    );
    const out = await handle.fetch('http://api/chat');
    await readAllText(out.body!);
    const dupes = emitter.getLog().filter((e) => e.type === 'fetch-stream:chunk-duplicated');
    expect(dupes[0].detail.phase).toBe('ai:chunk-duplicated');
  });

  it('tags truncated events with phase ai:stream-truncated', async () => {
    const { handle, emitter } = setup(
      { closes: [{ urlPattern: '*', afterChunk: 1, probability: 1 }] },
      new StreamResponse(makeStream(['a', 'b', 'c'])),
    );
    const out = await handle.fetch('http://api/chat');
    await readAllText(out.body!);
    const truncates = emitter.getLog().filter((e) => e.type === 'fetch-stream:truncated');
    expect(truncates[0].detail.phase).toBe('ai:stream-truncated');
    expect(truncates[0].detail.chunkIndex).toBe(1);
  });

  it('reuses the same connectionId across all events for one response', async () => {
    const { handle, emitter } = setup(
      { delays: [{ urlPattern: '*', delayMs: 0, probability: 1 }] },
      new StreamResponse(makeStream(['a', 'b'])),
    );
    const out = await handle.fetch('http://api/chat');
    await readAllText(out.body!);
    const ids = new Set(
      emitter
        .getLog()
        .filter((e) => e.type.startsWith('fetch-stream:'))
        .map((e) => e.detail.connectionId),
    );
    expect(ids.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sse phase emission
// ---------------------------------------------------------------------------

class MockEventSource extends EventTarget {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSED = 2 as const;
  CONNECTING = 0;
  OPEN = 1;
  CLOSED = 2;
  readyState = MockEventSource.CONNECTING;
  url: string;
  withCredentials: boolean;
  constructor(url: string | URL, init?: EventSourceInit) {
    super();
    this.url = typeof url === 'string' ? url : url.toString();
    this.withCredentials = init?.withCredentials ?? false;
  }
  close() {
    this.readyState = MockEventSource.CLOSED;
  }
  simulateMessage(data: string, type = 'message') {
    const evt = new MessageEvent(type, { data });
    this.dispatchEvent(evt);
    return evt;
  }
}

describe('sse phase emission', () => {
  const handles: EventSourcePatchHandle[] = [];
  afterEach(() => {
    while (handles.length) handles.pop()!.uninstall();
  });

  function setup(config: SSEConfig) {
    const emitter = new ChaosEventEmitter();
    const counters = new Map<object, number>();
    const handle = patchEventSource(
      MockEventSource as unknown as EventSourceLikeStatic,
      config,
      emitter,
      () => 0,
      counters,
    );
    handles.push(handle);
    return { emitter, Wrapped: handle.Wrapped as unknown as new (url: string) => MockEventSource };
  }

  it('emits a sse:lifecycle event with phase ai:first-chunk on the first message', () => {
    const { emitter, Wrapped } = setup({});
    const src = new Wrapped('http://api/stream');
    src.simulateMessage('hello');
    const lifecycle = emitter.getLog().filter((e) => e.type === 'sse:lifecycle');
    expect(lifecycle.length).toBe(1);
    expect(lifecycle[0].detail.phase).toBe('ai:first-chunk');
    expect(lifecycle[0].detail.chunkIndex).toBe(0);
    expect(typeof lifecycle[0].detail.connectionId).toBe('string');
  });

  it('tags sse:delay events with phase ai:stream-paused', () => {
    const { emitter, Wrapped } = setup({
      delays: [{ urlPattern: '*', delayMs: 5, probability: 1 }],
    });
    const src = new Wrapped('http://api/stream');
    src.simulateMessage('hello');
    const delays = emitter.getLog().filter((e) => e.type === 'sse:delay');
    expect(delays[0].detail.phase).toBe('ai:stream-paused');
    expect(typeof delays[0].detail.connectionId).toBe('string');
  });

  it('tags sse:close events with phase ai:stream-truncated', async () => {
    const { emitter, Wrapped } = setup({
      closes: [{ urlPattern: '*', afterMs: 0, probability: 1 }],
    });
    new Wrapped('http://api/stream');
    await new Promise((r) => setTimeout(r, 5));
    const closes = emitter.getLog().filter((e) => e.type === 'sse:close');
    expect(closes[0].detail.phase).toBe('ai:stream-truncated');
  });

  it('increments chunkIndex across consecutive messages on the same source', () => {
    const { emitter, Wrapped } = setup({});
    const src = new Wrapped('http://api/stream');
    src.simulateMessage('a');
    src.simulateMessage('b');
    src.simulateMessage('c');
    const lifecycle = emitter.getLog().filter((e) => e.type === 'sse:lifecycle');
    expect(lifecycle.length).toBe(1); // only first-chunk marker
    // Without any chaos rules, only the lifecycle marker is emitted; ensure
    // the connectionId stays stable across messages by switching on a chaos
    // rule and checking the emitted events.
    const { emitter: emitter2, Wrapped: Wrapped2 } = setup({
      delays: [{ urlPattern: '*', delayMs: 0, probability: 1 }],
    });
    const src2 = new Wrapped2('http://api/stream');
    src2.simulateMessage('a');
    src2.simulateMessage('b');
    const delays = emitter2.getLog().filter((e) => e.type === 'sse:delay');
    expect(delays.length).toBe(2);
    expect(delays[0].detail.chunkIndex).toBe(0);
    expect(delays[1].detail.chunkIndex).toBe(1);
    expect(delays[0].detail.connectionId).toBe(delays[1].detail.connectionId);
  });
});

// ---------------------------------------------------------------------------
// websocket inbound phase emission
// ---------------------------------------------------------------------------

class MockWebSocket extends EventTarget {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;
  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  url: string;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  constructor(url: string | URL) {
    super();
    this.url = typeof url === 'string' ? url : url.toString();
    // Surface OPEN immediately so scheduleCloseChaos can fire synchronously.
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(_data: unknown) { /* no-op */ }
  close(_code?: number, _reason?: string) { this.readyState = MockWebSocket.CLOSED; }
  simulateInbound(data: string | ArrayBuffer | Blob) {
    const evt = new MessageEvent('message', { data });
    this.dispatchEvent(evt);
    return evt;
  }
}

describe('websocket inbound phase emission', () => {
  const handles: WebSocketPatchHandle[] = [];
  afterEach(() => {
    while (handles.length) handles.pop()!.uninstall();
  });

  function setup(config: WebSocketConfig) {
    const emitter = new ChaosEventEmitter();
    const counters = new Map<object, number>();
    const handle = patchWebSocket(
      MockWebSocket as unknown as typeof WebSocket,
      config,
      emitter,
      () => 0,
      counters,
    );
    handles.push(handle);
    return { emitter, Wrapped: handle.Wrapped as unknown as new (url: string) => MockWebSocket };
  }

  it('emits a websocket:lifecycle event with phase ai:first-chunk on the first inbound message', () => {
    const { emitter, Wrapped } = setup({});
    const ws = new Wrapped('ws://api/stream');
    ws.simulateInbound('hello');
    const lifecycle = emitter.getLog().filter((e) => e.type === 'websocket:lifecycle');
    expect(lifecycle.length).toBe(1);
    expect(lifecycle[0].detail.phase).toBe('ai:first-chunk');
    expect(lifecycle[0].detail.direction).toBe('inbound');
    expect(typeof lifecycle[0].detail.connectionId).toBe('string');
  });

  it('tags inbound delay events with phase ai:stream-paused and stays direction-aware', () => {
    const { emitter, Wrapped } = setup({
      delays: [{ urlPattern: '*', direction: 'inbound', delayMs: 5, probability: 1 }],
    });
    const ws = new Wrapped('ws://api/stream');
    ws.simulateInbound('hello');
    const delays = emitter.getLog().filter((e) => e.type === 'websocket:delay');
    expect(delays[0].detail.phase).toBe('ai:stream-paused');
    expect(delays[0].detail.chunkIndex).toBe(0);
  });

  it('does not tag outbound delay events with an ai phase', () => {
    const { emitter, Wrapped } = setup({
      delays: [{ urlPattern: '*', direction: 'outbound', delayMs: 5, probability: 1 }],
    });
    const ws = new Wrapped('ws://api/stream');
    ws.send('hello');
    const delays = emitter.getLog().filter((e) => e.type === 'websocket:delay');
    expect(delays[0].detail.phase).toBeUndefined();
  });
});
