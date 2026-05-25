import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChaosEventEmitter } from '../src/events';
import { patchFetch } from '../src/interceptors/networkFetch';
import { mockFetch } from './setup';

const ok = () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));

describe('Debug Mode  -  disabled fast-path', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits zero debug events and zero console.debug calls over 10k requests with 5 rules', async () => {
    const emitter = new ChaosEventEmitter(20000);
    // No logger attached → emitter.debug() must be a no-op.
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    mockFetch.mockImplementation(ok);

    const wrapped = patchFetch(
      mockFetch as unknown as typeof globalThis.fetch,
      {
        failures: [
          { urlPattern: '/api/a', statusCode: 500, probability: 0 },
          { urlPattern: '/api/b', statusCode: 500, probability: 0 },
        ],
        latencies: [
          { urlPattern: '/api/c', delayMs: 0, probability: 0 },
          { urlPattern: '/api/d', delayMs: 0, probability: 0 },
        ],
        cors: [{ urlPattern: '/api/e', probability: 0 }],
      },
      () => 1, // forces shouldApplyChaos false on every call
      emitter,
    );

    for (let i = 0; i < 10000; i++) {
      await wrapped(`/api/a/${i}`);
    }

    expect(debugSpy).not.toHaveBeenCalled();
    const debugEvents = emitter.getLog().filter((e) => e.type === 'debug');
    expect(debugEvents.length).toBe(0);
  });
});
