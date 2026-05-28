import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChaosEventEmitter } from '../src/events';
import { patchFetchStream, type FetchStreamPatchHandle } from '../src/interceptors/networkFetchStream';
import type { FetchStreamConfig } from '../src/config';

// Minimal Response replacement with a real body getter so the interceptor's
// `Object.getOwnPropertyDescriptor(Response.prototype, 'body')` lookup finds
// something it can wrap. The setup file stubs Response with a value-typed
// `body` field; this file's stub overrides that for fetch-stream tests.
class StreamResponse {
  private readonly _stream: ReadableStream<Uint8Array> | null;
  constructor(stream: ReadableStream<Uint8Array> | null) {
    this._stream = stream;
  }
  get body(): ReadableStream<Uint8Array> | null {
    return this._stream;
  }
}

let originalResponse: unknown;
const installedHandles: FetchStreamPatchHandle[] = [];

beforeEach(() => {
  originalResponse = (globalThis as { Response?: unknown }).Response;
  vi.stubGlobal('Response', StreamResponse);
});

afterEach(() => {
  // Always tear down installed patches even when a `.toEqual` assertion
  // fails mid-test, otherwise a leaked body-getter from one test will
  // double-wrap the next test's streams.
  while (installedHandles.length) {
    installedHandles.pop()!.uninstall();
  }
  vi.stubGlobal('Response', originalResponse);
});

function makeStream(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        const value = chunks[i++];
        controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value);
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

function setup(config: FetchStreamConfig, response: StreamResponse, random: () => number = () => 0) {
  const emitter = new ChaosEventEmitter();
  const counters = new Map<object, number>();
  const originalFetch = vi.fn().mockResolvedValue(response);
  const handle = patchFetchStream(
    originalFetch as unknown as typeof fetch,
    config,
    random,
    emitter,
    counters,
  );
  installedHandles.push(handle);
  return { handle, emitter, counters, originalFetch };
}

describe('patchFetchStream: matcher gating', () => {
  it('passes responses through unwrapped when no rule matches', async () => {
    const response = new StreamResponse(makeStream(['a', 'b', 'c']));
    const { handle } = setup(
      { drops: [{ urlPattern: '/other', probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    expect(chunks).toEqual(['a', 'b', 'c']);
    handle.uninstall();
  });

  it('wraps body when urlPattern matches', async () => {
    const response = new StreamResponse(makeStream(['a', 'b', 'c']));
    const { handle, emitter } = setup(
      { drops: [{ urlPattern: '/chat', chunkIndex: 1, probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    expect(chunks).toEqual(['a', 'c']);
    const log = emitter.getLog();
    expect(log.some((e) => e.type === 'fetch-stream:chunk-dropped' && e.detail.chunkIndex === 1)).toBe(true);
    handle.uninstall();
  });
});

describe('patchFetchStream: chunk drop', () => {
  it('drops every chunk when probability is 1 and chunkIndex is omitted', async () => {
    const response = new StreamResponse(makeStream(['a', 'b', 'c']));
    const { handle } = setup(
      { drops: [{ urlPattern: '*', probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    expect(chunks).toEqual([]);
    handle.uninstall();
  });

  it('honours an explicit chunkIndex gate', async () => {
    const response = new StreamResponse(makeStream(['a', 'b', 'c', 'd']));
    const { handle } = setup(
      { drops: [{ urlPattern: '*', chunkIndex: 2, probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    expect(chunks).toEqual(['a', 'b', 'd']);
    handle.uninstall();
  });
});

describe('patchFetchStream: chunk delay', () => {
  it('emits a chunk-delayed event and still enqueues the chunk', async () => {
    const response = new StreamResponse(makeStream(['a', 'b']));
    const { handle, emitter } = setup(
      { delays: [{ urlPattern: '*', delayMs: 10, probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    expect(chunks).toEqual(['a', 'b']);
    const delays = emitter.getLog().filter((e) => e.type === 'fetch-stream:chunk-delayed');
    expect(delays.length).toBe(2);
    expect(delays[0].detail.delayMs).toBe(10);
    handle.uninstall();
  });
});

describe('patchFetchStream: chunk corruption', () => {
  it('mutates chunk text under the truncate strategy', async () => {
    const response = new StreamResponse(makeStream(['hello world']));
    const { handle, emitter } = setup(
      { corruptions: [{ urlPattern: '*', strategy: 'truncate', probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    // truncate slices to floor(len/2): 11 → 5 → 'hello'
    expect(chunks).toEqual(['hello']);
    expect(emitter.getLog().some((e) => e.type === 'fetch-stream:chunk-corrupted')).toBe(true);
    handle.uninstall();
  });

  it('duplicate strategy enqueues the chunk twice', async () => {
    const response = new StreamResponse(makeStream(['x', 'y']));
    const { handle, emitter } = setup(
      { corruptions: [{ urlPattern: '*', strategy: 'duplicate', probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    expect(chunks).toEqual(['x', 'x', 'y', 'y']);
    const dupes = emitter.getLog().filter((e) => e.type === 'fetch-stream:chunk-duplicated');
    expect(dupes.length).toBe(2);
    handle.uninstall();
  });
});

describe('patchFetchStream: close (truncate) rules', () => {
  it('truncates the stream after the configured chunk index', async () => {
    const response = new StreamResponse(makeStream(['a', 'b', 'c', 'd']));
    const { handle, emitter } = setup(
      { closes: [{ urlPattern: '*', afterChunk: 2, probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    expect(chunks).toEqual(['a', 'b']);
    const truncates = emitter.getLog().filter((e) => e.type === 'fetch-stream:truncated');
    expect(truncates.length).toBe(1);
    expect(truncates[0].detail.reason).toBe('after-chunk');
    handle.uninstall();
  });
});

describe('patchFetchStream: tee() double-read safety', () => {
  it('first body access gets the chaos branch, second access gets the unmutated branch', async () => {
    const response = new StreamResponse(makeStream(['a', 'b', 'c']));
    const { handle } = setup(
      { drops: [{ urlPattern: '*', chunkIndex: 1, probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const firstBranch = out.body!;
    const secondBranch = out.body!;
    // The two getters return distinct stream objects (no TypeError: locked).
    expect(firstBranch).not.toBe(secondBranch);
    const firstChunks = await readAllText(firstBranch);
    const secondChunks = await readAllText(secondBranch);
    expect(firstChunks).toEqual(['a', 'c']);
    expect(secondChunks).toEqual(['a', 'b', 'c']);
    handle.uninstall();
  });
});

describe('patchFetchStream: cleanup', () => {
  it('uninstall restores the original Response.body getter', async () => {
    const before = Object.getOwnPropertyDescriptor(StreamResponse.prototype, 'body');
    const { handle } = setup(
      { drops: [{ urlPattern: '*', probability: 1 }] },
      new StreamResponse(makeStream(['a'])),
    );
    const duringPatch = Object.getOwnPropertyDescriptor(StreamResponse.prototype, 'body');
    expect(duringPatch?.get).not.toBe(before?.get);
    handle.uninstall();
    const after = Object.getOwnPropertyDescriptor(StreamResponse.prototype, 'body');
    expect(after?.get).toBe(before?.get);
  });

  it('uninstall makes the wrapped fetch fall through without setting meta', async () => {
    const response = new StreamResponse(makeStream(['x', 'y']));
    const { handle } = setup(
      { drops: [{ urlPattern: '*', probability: 1 }] },
      response,
    );
    handle.uninstall();
    // After uninstall, the stub fetch still runs but body should be raw.
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    expect(chunks).toEqual(['x', 'y']);
  });
});
