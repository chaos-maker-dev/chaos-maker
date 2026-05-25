import { describe, it, expect, afterEach, vi } from 'vitest';
import { ChaosMaker } from '../src/ChaosMaker';
import { ChaosConfig } from '../src/config';
import { ChaosConfigError } from '../src/errors';

const originalFetch = global.fetch;
const originalXhrOpen = global.XMLHttpRequest.prototype.open;
const originalXhrSend = global.XMLHttpRequest.prototype.send;
const originalMutationObserver = global.MutationObserver;

function restore() {
  global.fetch = originalFetch;
  global.XMLHttpRequest.prototype.open = originalXhrOpen;
  global.XMLHttpRequest.prototype.send = originalXhrSend;
  global.MutationObserver = originalMutationObserver;
  vi.useRealTimers();
}

describe('ChaosMaker edge cases', () => {
  afterEach(restore);

  // --- Double start ---

  it('should handle double start as a no-op', () => {
    const config: ChaosConfig = { network: {} };
    const cm = new ChaosMaker(config);

    cm.start();
    const fetchAfterFirst = global.fetch;

    // Second start is a no-op  -  does not re-patch
    cm.start();
    expect(global.fetch).toBe(fetchAfterFirst);

    cm.stop();
  });

  it('should restore to original fetch after double start then stop', () => {
    const config: ChaosConfig = { network: {} };
    const cm = new ChaosMaker(config);

    cm.start();
    cm.start(); // no-op due to running guard
    cm.stop();

    // Original is correctly preserved since second start was a no-op
    expect(global.fetch).toBe(originalFetch);
  });

  // --- Stop without start ---

  it('should handle stop without start gracefully', () => {
    const config: ChaosConfig = { network: {} };
    const cm = new ChaosMaker(config);

    // Should not throw
    expect(() => cm.stop()).not.toThrow();

    // Globals should remain untouched
    expect(global.fetch).toBe(originalFetch);
  });

  it('should handle double stop gracefully', () => {
    const config: ChaosConfig = { network: {} };
    const cm = new ChaosMaker(config);

    cm.start();
    cm.stop();

    // Second stop should not throw
    expect(() => cm.stop()).not.toThrow();
    expect(global.fetch).toBe(originalFetch);
  });

  it('can start, stop, and start again without retaining saved handles', () => {
    const cm = new ChaosMaker({ network: {} });

    cm.start();
    const fetchAfterFirstStart = global.fetch;
    cm.stop();
    expect(global.fetch).toBe(originalFetch);

    cm.start();
    expect(global.fetch).not.toBe(originalFetch);
    expect(global.fetch).not.toBe(fetchAfterFirstStart);
    cm.stop();
    expect(global.fetch).toBe(originalFetch);
  });

  it('allows a fresh instance to replace a stopped instance cleanly', async () => {
    const first = new ChaosMaker({
      network: { failures: [{ urlPattern: '/api', statusCode: 500, probability: 1 }] },
    });
    first.start();
    expect((await global.fetch('/api')).status).toBe(500);
    first.stop();

    const second = new ChaosMaker({
      network: { failures: [{ urlPattern: '/api', statusCode: 503, probability: 1 }] },
    });
    second.start();
    expect((await global.fetch('/api')).status).toBe(503);
    second.stop();
    expect(global.fetch).toBe(originalFetch);
  });

  it('fails fast when another active instance already owns the target', async () => {
    const first = new ChaosMaker({
      network: { failures: [{ urlPattern: '/api', statusCode: 500, probability: 1 }] },
    });
    const second = new ChaosMaker({ network: {}, debug: true });

    first.start();
    try {
      expect(() => second.start()).toThrow(/active runtime instance/);

      const reasons = second.getLog()
        .filter((event) => event.type === 'debug')
        .map((event) => event.detail.reason);
      expect(reasons).toContain('active-instance-conflict');

      const res = await global.fetch('/api');
      expect(res.status).toBe(500);
    } finally {
      first.stop();
    }
    expect(global.fetch).toBe(originalFetch);
  });

  // --- Multiple instances ---

  it('rejects concurrent instances before overwriting the active patch', async () => {
    const config1: ChaosConfig = {
      network: {
        failures: [{ urlPattern: '/api/one', statusCode: 500, probability: 1.0 }],
      },
    };
    const config2: ChaosConfig = {
      network: {
        failures: [{ urlPattern: '/api/two', statusCode: 503, probability: 1.0 }],
      },
    };

    const cm1 = new ChaosMaker(config1);
    const cm2 = new ChaosMaker(config2);

    cm1.start();
    try {
      expect(() => cm2.start()).toThrow(/active runtime instance/);

      const resOne = await global.fetch('/api/one');
      expect(resOne.status).toBe(500);

      const resTwo = await global.fetch('/api/two');
      expect(resTwo).toBeUndefined();
    } finally {
      cm1.stop();
    }

    expect(global.fetch).toBe(originalFetch);
  });

  // --- Event log ---

  it('should return empty log before start', () => {
    const config: ChaosConfig = { network: {} };
    const cm = new ChaosMaker(config);
    expect(cm.getLog()).toEqual([]);
  });

  it('should accumulate events across multiple requests', async () => {
    const config: ChaosConfig = {
      network: {
        failures: [{ urlPattern: '/api/', statusCode: 500, probability: 1.0 }],
      },
    };
    const cm = new ChaosMaker(config);
    cm.start();

    await global.fetch('/api/a');
    await global.fetch('/api/b');
    await global.fetch('/api/c');

    expect(cm.getLog().length).toBe(3);
    expect(cm.getLog().every((e) => e.type === 'network:failure' && e.applied)).toBe(true);

    cm.stop();
  });

  it('should clear log independently of chaos state', async () => {
    const config: ChaosConfig = {
      network: {
        failures: [{ urlPattern: '/api/', statusCode: 500, probability: 1.0 }],
      },
    };
    const cm = new ChaosMaker(config);
    cm.start();

    await global.fetch('/api/test');
    expect(cm.getLog().length).toBe(1);

    cm.clearLog();
    expect(cm.getLog().length).toBe(0);

    // Chaos still works after clearing log
    await global.fetch('/api/test');
    expect(cm.getLog().length).toBe(1);

    cm.stop();
  });

  // --- Config validation ---

  it('should reject invalid config at construction time', () => {
    expect(() => {
      new ChaosMaker({
        network: {
          failures: [{ urlPattern: '', statusCode: 999, probability: 2.0 }],
        },
      });
    }).toThrow(ChaosConfigError);
  });

  // --- Empty config ---

  it('should handle empty config without patching anything', () => {
    const cm = new ChaosMaker({});
    cm.start();

    // No network config means fetch/XHR not patched
    expect(global.fetch).toBe(originalFetch);
    expect(global.XMLHttpRequest.prototype.send).toBe(originalXhrSend);

    cm.stop();
  });

  it('should handle ui-only config without patching network', () => {
    const cm = new ChaosMaker({
      ui: {
        assaults: [{ selector: 'button', action: 'disable', probability: 1.0 }],
      },
    });
    cm.start();

    // fetch/XHR should NOT be patched
    expect(global.fetch).toBe(originalFetch);
    expect(global.XMLHttpRequest.prototype.send).toBe(originalXhrSend);

    cm.stop();
  });

  it('disconnects DOM observers during stop', () => {
    const disconnect = vi.fn();
    class FakeMutationObserver {
      constructor(_callback: MutationCallback) {}
      observe = vi.fn();
      disconnect = disconnect;
      takeRecords = vi.fn(() => []);
    }
    global.MutationObserver = FakeMutationObserver as unknown as typeof MutationObserver;
    const cm = new ChaosMaker({
      ui: {
        assaults: [{ selector: 'button', action: 'disable', probability: 1 }],
      },
    });

    cm.start();
    cm.stop();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('cancels delayed WebSocket sends during stop', async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    class FakeWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string | URL) {
        super();
      }
      send(data: unknown): void {
        sent.push(data);
      }
      close(): void {
        this.readyState = FakeWebSocket.CLOSED;
      }
    }
    const target = {
      WebSocket: FakeWebSocket,
    } as unknown as typeof globalThis;
    const cm = new ChaosMaker({
      websocket: {
        delays: [{ urlPattern: '/ws', direction: 'outbound', delayMs: 100, probability: 1 }],
      },
    }, { target });

    cm.start();
    const socket = new target.WebSocket('/ws');
    socket.send('hello');
    expect(sent).toEqual([]);

    cm.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(sent).toEqual([]);
    expect(cm.getLog().some(
      (event) => event.type === 'websocket:drop' && event.detail.reason === 'stop-during-delay',
    )).toBe(true);
  });

  it('cancels delayed EventSource messages during stop', async () => {
    vi.useFakeTimers();
    let received = 0;
    class FakeEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readyState = FakeEventSource.OPEN;
      constructor(readonly url: string | URL) {
        super();
      }
      close(): void {
        this.readyState = FakeEventSource.CLOSED;
      }
    }
    const target = {
      EventSource: FakeEventSource,
    } as unknown as typeof globalThis;
    const cm = new ChaosMaker({
      sse: {
        delays: [{ urlPattern: '/events', eventType: 'message', delayMs: 100, probability: 1 }],
      },
    }, { target });

    cm.start();
    const source = new target.EventSource('/events');
    source.addEventListener('message', () => {
      received += 1;
    });
    source.dispatchEvent(new MessageEvent('message', { data: 'payload' }));
    expect(received).toBe(0);

    cm.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(received).toBe(0);
    expect(cm.getLog().some(
      (event) => event.type === 'sse:drop' && event.detail.reason === 'stop-during-delay',
    )).toBe(true);
  });
});
