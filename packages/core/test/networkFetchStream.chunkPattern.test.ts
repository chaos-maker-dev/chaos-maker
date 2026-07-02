import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChaosEventEmitter } from '../src/events';
import { patchFetchStream, type FetchStreamPatchHandle } from '../src/interceptors/networkFetchStream';
import { matchChunkText } from '../src/matchers';
import { serializeForTransport, deserializeForTransport } from '../src/transport';
import type { ChaosConfig, FetchStreamConfig } from '../src/config';

// Same body-getter stub the base fetch-stream suite uses; see
// networkFetchStream.test.ts for why the setup-file Response stub is not
// enough here.
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

// Invalid UTF-8: a lone continuation byte.
const BINARY_CHUNK = new Uint8Array([0x80, 0xff, 0xfe]);

describe('matchChunkText', () => {
  it('matches a string pattern by substring containment', () => {
    expect(matchChunkText('data: {"tool_calls":[]}', 'tool_calls')).toBe(true);
    expect(matchChunkText('data: {"content":"hi"}', 'tool_calls')).toBe(false);
  });

  it('is case-sensitive for string patterns', () => {
    expect(matchChunkText('TOOL_CALLS', 'tool_calls')).toBe(false);
  });

  it('matches a RegExp pattern via test', () => {
    expect(matchChunkText('{"tool_use":{}}', /"(tool_calls|tool_use)"/)).toBe(true);
    expect(matchChunkText('{"content":"x"}', /"(tool_calls|tool_use)"/)).toBe(false);
  });
});

describe('patchFetchStream: chunkPattern gating', () => {
  it('corrupts only the chunks whose text matches a string pattern', async () => {
    const response = new StreamResponse(makeStream(['plain', '{"tool_calls":[]}', 'tail']));
    const { handle, emitter } = setup(
      { corruptions: [{ urlPattern: '*', chunkPattern: 'tool_calls', strategy: 'empty', probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    expect(chunks).toEqual(['plain', '', 'tail']);
    const corrupted = emitter.getLog().filter((e) => e.type === 'fetch-stream:chunk-corrupted' && e.applied);
    expect(corrupted).toHaveLength(1);
    expect(corrupted[0]!.detail.chunkIndex).toBe(1);
  });

  it('matches with a RegExp pattern', async () => {
    const response = new StreamResponse(makeStream(['{"tool_use":{}}', 'other']));
    const { handle } = setup(
      { corruptions: [{ urlPattern: '*', chunkPattern: /"(tool_calls|tool_use)"/, strategy: 'empty', probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    expect(chunks).toEqual(['', 'other']);
  });

  it('combines chunkPattern with chunkIndex (both must hold)', async () => {
    const response = new StreamResponse(makeStream(['tool a', 'tool b', 'tool c']));
    const { handle } = setup(
      { corruptions: [{ urlPattern: '*', chunkIndex: 1, chunkPattern: 'tool', strategy: 'empty', probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    expect(chunks).toEqual(['tool a', '', 'tool c']);
  });

  it('counts only matching chunks for onNth gating', async () => {
    const response = new StreamResponse(makeStream(['tool 1', 'skip', 'tool 2', 'tool 3']));
    const { handle } = setup(
      { corruptions: [{ urlPattern: '*', chunkPattern: 'tool', strategy: 'empty', probability: 1, onNth: 2 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    // Second MATCHING chunk is index 2; the non-matching 'skip' chunk must not
    // advance the counter.
    expect(chunks).toEqual(['tool 1', 'skip', '', 'tool 3']);
  });

  it('stamps the rule phase tag onto the corruption event', async () => {
    const response = new StreamResponse(makeStream(['{"tool_calls":[]}']));
    const { handle, emitter } = setup(
      {
        corruptions: [
          { urlPattern: '*', chunkPattern: 'tool_calls', strategy: 'malformed-json', probability: 1, phase: 'ai:tool-call-failed' },
        ],
      },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    await readAllText(out.body!);
    const corrupted = emitter.getLog().filter((e) => e.type === 'fetch-stream:chunk-corrupted' && e.applied);
    expect(corrupted).toHaveLength(1);
    expect(corrupted[0]!.detail.phase).toBe('ai:tool-call-failed');
  });

  it('leaves the phase off events when the rule has no tag', async () => {
    const response = new StreamResponse(makeStream(['tool']));
    const { handle, emitter } = setup(
      { corruptions: [{ urlPattern: '*', chunkPattern: 'tool', strategy: 'empty', probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    await readAllText(out.body!);
    const corrupted = emitter.getLog().filter((e) => e.type === 'fetch-stream:chunk-corrupted' && e.applied);
    expect(corrupted[0]!.detail.phase).toBeUndefined();
  });

  it('skips binary chunks and emits one diagnostic per rule per connection', async () => {
    const response = new StreamResponse(makeStream([BINARY_CHUNK, BINARY_CHUNK, 'tool text']));
    const { handle, emitter } = setup(
      { corruptions: [{ urlPattern: '*', chunkPattern: 'tool', strategy: 'empty', probability: 1 }] },
      response,
    );
    const out = await handle.fetch('http://api/chat');
    const chunks = await readAllText(out.body!);
    // Binary chunks pass through untouched; the matching text chunk is emptied.
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toBe('');
    const diagnostics = emitter
      .getLog()
      .filter((e) => e.type === 'fetch-stream:chunk-corrupted' && !e.applied && e.detail.reason === 'binary-chunk');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.detail.chunkIndex).toBe(0);
  });
});

describe('chunkPattern page-boundary serialization', () => {
  it('round-trips a RegExp chunkPattern through transport serialization', () => {
    const config: ChaosConfig = {
      fetchStream: {
        corruptions: [
          { urlPattern: '*', chunkPattern: /"(tool_calls|tool_use)"/, strategy: 'malformed-json', probability: 1, phase: 'ai:tool-call-failed' },
        ],
      },
    };
    const wire = JSON.parse(JSON.stringify(serializeForTransport(config))) as unknown;
    const revived = deserializeForTransport(wire) as ChaosConfig;
    const rule = revived.fetchStream!.corruptions![0]!;
    expect(rule.chunkPattern).toBeInstanceOf(RegExp);
    expect((rule.chunkPattern as RegExp).source).toBe('"(tool_calls|tool_use)"');
    expect(rule.phase).toBe('ai:tool-call-failed');
  });
});
