import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChaosEventEmitter } from '../src/events';
import { patchFetchStream, type FetchStreamPatchHandle } from '../src/interceptors/networkFetchStream';
import { StreamCancelRegistry } from '../src/interceptors/streamCancelRegistry';
import type { FetchStreamConfig, ReplayFixture } from '../src/config';

function replayFixture(): ReplayFixture {
  return {
    version: 1,
    transport: 'fetch-stream',
    chunks: [{ offsetMs: 0, data: 'R1' }],
  };
}

// Same minimal Response replacement the main fetch-stream suite uses: a real
// `body` getter so the interceptor's descriptor lookup finds something to wrap.
class StreamResponse {
  private readonly _stream: ReadableStream<Uint8Array> | null;
  constructor(stream: ReadableStream<Uint8Array> | null = null) {
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
  while (installedHandles.length) {
    installedHandles.pop()!.uninstall();
  }
  vi.stubGlobal('Response', originalResponse);
});

function setup(config: FetchStreamConfig, registry?: StreamCancelRegistry) {
  const emitter = new ChaosEventEmitter();
  const counters = new Map<object, number>();
  const seenInits: Array<RequestInit | undefined> = [];
  const originalFetch = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
    seenInits.push(init);
    return new StreamResponse() as unknown as Response;
  });
  const handle = patchFetchStream(
    originalFetch as unknown as typeof fetch,
    config,
    () => 0,
    emitter,
    counters,
    undefined,
    undefined,
    registry,
  );
  installedHandles.push(handle);
  return { handle, emitter, seenInits };
}

describe('patchFetchStream: cancel registry integration', () => {
  it('injects an abort signal and registers the connection when armed', async () => {
    const registry = new StreamCancelRegistry();
    const { handle, seenInits } = setup({}, registry);
    await handle.fetch('http://api/chat', { method: 'POST' });

    expect(seenInits).toHaveLength(1);
    expect(seenInits[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seenInits[0]?.method).toBe('POST');

    const cancelled = registry.cancelAll();
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].transport).toBe('fetch-stream');
    expect(cancelled[0].url).toBe('http://api/chat');
    expect(seenInits[0]!.signal!.aborted).toBe(true);
  });

  it('leaves init untouched without a registry', async () => {
    const { handle, seenInits } = setup({});
    await handle.fetch('http://api/chat', { method: 'POST' });
    expect(seenInits[0]?.signal).toBeUndefined();
  });

  it('mirrors the caller signal into the injected controller', async () => {
    const registry = new StreamCancelRegistry();
    const { handle, seenInits } = setup({}, registry);
    const caller = new AbortController();
    await handle.fetch('http://api/chat', { signal: caller.signal });

    const injected = seenInits[0]!.signal!;
    expect(injected).not.toBe(caller.signal);
    expect(injected.aborted).toBe(false);
    caller.abort();
    expect(injected.aborted).toBe(true);
  });

  it('propagates an already-aborted caller signal immediately', async () => {
    const registry = new StreamCancelRegistry();
    const { handle, seenInits } = setup({}, registry);
    const caller = new AbortController();
    caller.abort();
    await handle.fetch('http://api/chat', { signal: caller.signal });
    expect(seenInits[0]!.signal!.aborted).toBe(true);
  });

  it('reports false on a second cancel of the same connection', async () => {
    const registry = new StreamCancelRegistry();
    const { handle } = setup({}, registry);
    await handle.fetch('http://api/chat');

    const [connection] = registry.cancelAll();
    expect(connection.cancel()).toBe(false);
  });

  it('does not report a block-mode replay connection as cancelled', async () => {
    const registry = new StreamCancelRegistry();
    const { handle } = setup(
      { replay: { urlPattern: '/chat', data: replayFixture() } },
      registry,
    );
    await handle.fetch('http://api/chat');
    // Block-mode replay owns a fixture stream the injected AbortController never
    // reaches, so the connection is unregistered rather than falsely reported as
    // an applied cancel.
    expect(registry.cancelAll()).toHaveLength(0);
  });

  it('still registers a substitute-mode replay connection', async () => {
    const registry = new StreamCancelRegistry();
    const { handle } = setup(
      { replay: { urlPattern: '/chat', blockUpstream: false, data: replayFixture() } },
      registry,
    );
    await handle.fetch('http://api/chat');
    // Substitute mode fires the real request, so its abort signal is live and
    // the connection stays cancellable.
    expect(registry.cancelAll()).toHaveLength(1);
  });

  it('attaches the connectionId for rule-matched requests', async () => {
    const registry = new StreamCancelRegistry();
    const { handle } = setup(
      { drops: [{ urlPattern: '/chat', chunkIndex: 0, probability: 1 }] },
      registry,
    );
    await handle.fetch('http://api/chat');
    await handle.fetch('http://api/other');

    const cancelled = registry.cancelAll();
    expect(cancelled).toHaveLength(2);
    const matched = cancelled.find((c) => c.url === 'http://api/chat');
    const unmatched = cancelled.find((c) => c.url === 'http://api/other');
    expect(matched?.connectionId).toBeDefined();
    expect(unmatched?.connectionId).toBeUndefined();
  });
});
