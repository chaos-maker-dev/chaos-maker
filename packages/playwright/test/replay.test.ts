import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadStreamFixture, recordStreamFixture } from '../src/replay';

const tmpFiles: string[] = [];
function tmpFixtureFile(contents: unknown): string {
  const path = join(tmpdir(), `chaos-replay-${tmpFiles.length}-${process.pid}.json`);
  writeFileSync(path, JSON.stringify(contents));
  tmpFiles.push(path);
  return path;
}

afterEach(() => {
  while (tmpFiles.length) {
    try {
      rmSync(tmpFiles.pop()!);
    } catch {
      /* best effort */
    }
  }
  vi.unstubAllGlobals();
});

describe('loadStreamFixture', () => {
  it('reads and validates a v1 fixture from disk', () => {
    const path = tmpFixtureFile({
      version: 1,
      transport: 'fetch-stream',
      chunks: [{ offsetMs: 0, data: 'hi' }],
    });
    const fixture = loadStreamFixture(path);
    expect(fixture.version).toBe(1);
    expect(fixture.chunks).toHaveLength(1);
  });

  it('rejects a fixture with an unsupported version', () => {
    const path = tmpFixtureFile({ version: 2, transport: 'fetch-stream', chunks: [] });
    expect(() => loadStreamFixture(path)).toThrow(/version/i);
  });
});

describe('recordStreamFixture', () => {
  it('records a live stream into a v1 fixture', async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('a'));
            controller.enqueue(encoder.encode('b'));
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );
    const fixture = await recordStreamFixture('http://example.test/chat');
    expect(fixture.version).toBe(1);
    expect(fixture.transport).toBe('fetch-stream');
    expect(fixture.url).toBe('http://example.test/chat');
    expect(fixture.chunks.map((c) => c.data)).toEqual(['a', 'b']);
  });
});
