import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChaosEventEmitter } from '../src/events';
import { patchFetchStream, type FetchStreamPatchHandle } from '../src/interceptors/networkFetchStream';
import type { FetchStreamConfig, ReplayFixture } from '../src/config';

// A fuller Response stub than the plain body-getter one: it captures the body,
// status, and headers so block-mode replay (which constructs a whole Response)
// can be asserted end to end.
class ReplayResponse {
  private readonly _body: ReadableStream<Uint8Array> | null;
  readonly status: number;
  readonly headers: Headers;
  constructor(body?: ReadableStream<Uint8Array> | null, init?: { status?: number; headers?: Headers }) {
    this._body = body ?? null;
    this.status = init?.status ?? 200;
    this.headers = init?.headers ?? new Headers();
  }
  get body(): ReadableStream<Uint8Array> | null {
    return this._body;
  }
}

let originalResponse: unknown;
const installedHandles: FetchStreamPatchHandle[] = [];

beforeEach(() => {
  originalResponse = (globalThis as { Response?: unknown }).Response;
  vi.stubGlobal('Response', ReplayResponse);
});

afterEach(() => {
  while (installedHandles.length) {
    installedHandles.pop()!.uninstall();
  }
  vi.stubGlobal('Response', originalResponse);
});

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

function setup(config: FetchStreamConfig, realChunks: string[] = ['x', 'y']) {
  const emitter = new ChaosEventEmitter();
  const counters = new Map<object, number>();
  const originalFetch = vi.fn(async () => new ReplayResponse(makeStream(realChunks)));
  const handle = patchFetchStream(
    originalFetch as unknown as typeof fetch,
    config,
    () => 0,
    emitter,
    counters,
  );
  installedHandles.push(handle);
  return { handle, emitter, originalFetch };
}

describe('patchFetchStream: replay block mode (default)', () => {
  it('serves the fixture without touching the network', async () => {
    const { handle, emitter, originalFetch } = setup({
      replay: { urlPattern: '/chat', data: fixture() },
    });
    const out = await handle.fetch('http://api/chat');
    expect(originalFetch).not.toHaveBeenCalled();
    expect(await readAllText(out.body!)).toEqual(['R1', 'R2', 'R3']);
    const log = emitter.getLog();
    expect(log.some((e) => e.detail.phase === 'ai:stream-replayed')).toBe(true);
    expect(log.some((e) => e.detail.phase === 'ai:first-chunk')).toBe(true);
  });

  it('applies fixture status and content-type to the synthetic response', async () => {
    const { handle } = setup({
      replay: {
        urlPattern: '/chat',
        data: fixture({ status: 503, contentType: 'text/event-stream' }),
      },
    });
    const out = (await handle.fetch('http://api/chat')) as unknown as ReplayResponse;
    expect(out.status).toBe(503);
    expect(out.headers.get('content-type')).toBe('text/event-stream');
  });

  it('truncates and surfaces ai:stream-truncated', async () => {
    const { handle, emitter } = setup({
      replay: {
        urlPattern: '/chat',
        data: fixture(),
        mutations: [{ type: 'truncate', afterChunk: 1 }],
      },
    });
    const out = await handle.fetch('http://api/chat');
    expect(await readAllText(out.body!)).toEqual(['R1', 'R2']);
    expect(emitter.getLog().some((e) => e.detail.phase === 'ai:stream-truncated')).toBe(true);
  });

  it('duplicates a chunk and surfaces ai:chunk-duplicated', async () => {
    const { handle, emitter } = setup({
      replay: {
        urlPattern: '/chat',
        data: fixture(),
        mutations: [{ type: 'duplicate', chunkIndex: 0 }],
      },
    });
    const out = await handle.fetch('http://api/chat');
    expect(await readAllText(out.body!)).toEqual(['R1', 'R1', 'R2', 'R3']);
    expect(emitter.getLog().some((e) => e.detail.phase === 'ai:chunk-duplicated')).toBe(true);
  });
});

describe('patchFetchStream: replay substitute mode', () => {
  it('fires the real request but replaces the body with the fixture', async () => {
    const { handle, originalFetch } = setup({
      replay: { urlPattern: '/chat', blockUpstream: false, data: fixture() },
    });
    const out = await handle.fetch('http://api/chat');
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(await readAllText(out.body!)).toEqual(['R1', 'R2', 'R3']);
  });
});

describe('patchFetchStream: replay gating', () => {
  it('passes non-matching requests through to the real network body', async () => {
    const { handle, originalFetch } = setup(
      { replay: { urlPattern: '/chat', data: fixture() } },
      ['x', 'y'],
    );
    const out = await handle.fetch('http://api/other');
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(await readAllText(out.body!)).toEqual(['x', 'y']);
  });

  it('uninstall tears down without throwing', async () => {
    const { handle } = setup({ replay: { urlPattern: '/chat', data: fixture() } });
    await handle.fetch('http://api/chat');
    expect(() => handle.uninstall()).not.toThrow();
  });
});
