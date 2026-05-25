import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChaosConfig, ChaosEvent } from '../src';

/**
 * Service-worker-context simulation. jsdom exposes `self === window`, so we
 * can't just import `../src/sw` and call `installChaosSW()`  -  the module's
 * auto-install gate (`typeof importScripts === 'function'`) is false here, but
 * we need to drive the message handler directly to assert behavior.
 *
 * These tests install against a constructed "SW-like" target: an object
 * exposing `fetch`, `addEventListener`, `removeEventListener`, and a `clients`
 * stub so broadcast postMessage can be asserted.
 */

type MessageListener = (event: { data: unknown; ports?: unknown[] }) => void;

interface FakeClient {
  id: string;
  messages: unknown[];
  postMessage(m: unknown): void;
}

function makeFakeClient(id: string): FakeClient {
  const c: FakeClient = {
    id,
    messages: [],
    postMessage(m) { this.messages.push(m); },
  };
  return c;
}

interface SWLikeTarget {
  fetch: typeof globalThis.fetch;
  WebSocket?: typeof WebSocket;
  clients: {
    matchAll: (opts?: { includeUncontrolled?: boolean }) => Promise<readonly FakeClient[]>;
  };
  __messageListeners: Set<MessageListener>;
  addEventListener: (type: string, fn: MessageListener) => void;
  removeEventListener: (type: string, fn: MessageListener) => void;
  dispatchMessage: (data: unknown, ports?: unknown[]) => void;
  __CHAOS_CONFIG__?: ChaosConfig;
}

function makeSWTarget(clients: FakeClient[]): SWLikeTarget {
  const listeners = new Set<MessageListener>();
  const target: SWLikeTarget = {
    fetch: vi.fn().mockResolvedValue(new Response('real', { status: 200 })),
    clients: {
      matchAll: vi.fn().mockResolvedValue(clients),
    },
    __messageListeners: listeners,
    addEventListener(type, fn) {
      if (type === 'message') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'message') listeners.delete(fn);
    },
    dispatchMessage(data, ports) {
      for (const fn of listeners) fn({ data, ports });
    },
  };
  return target;
}

/** Dynamically import sw.ts with a patched globalThis.self so installChaosSW
 *  targets our fake. Isolated per test via vi.resetModules + module-scoped mark
 *  cleanup to avoid cross-test symbol bleed. */
async function importSwWithTarget(target: SWLikeTarget): Promise<typeof import('../src/sw')> {
  const INSTALL_MARK = Symbol.for('chaos-maker.sw.installed');
  delete (target as unknown as Record<symbol, unknown>)[INSTALL_MARK];
  vi.stubGlobal('self', target);
  const mod = await import('../src/sw');
  return mod;
}

describe('installChaosSW', () => {
  let origSelf: unknown;
  beforeEach(() => {
    vi.resetModules();
    origSelf = (globalThis as Record<string, unknown>).self;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    (globalThis as Record<string, unknown>).self = origSelf;
  });

  it('returns a no-op handle when fetch is missing', async () => {
    const broken = { addEventListener: () => { /* noop */ }, removeEventListener: () => { /* noop */ } } as unknown as SWLikeTarget;
    const { installChaosSW } = await importSwWithTarget(broken);
    const handle = installChaosSW();
    expect(handle.isRunning()).toBe(false);
    expect(handle.getSeed()).toBeNull();
    expect(handle.getLog()).toEqual([]);
    handle.uninstall();
  });

  it('is idempotent  -  second call returns the same handle', async () => {
    const target = makeSWTarget([makeFakeClient('a')]);
    const { installChaosSW } = await importSwWithTarget(target);
    const h1 = installChaosSW();
    const h2 = installChaosSW();
    expect(h1).toBe(h2);
    h1.uninstall();
  });

  it('patches fetch when a network config arrives via postMessage', async () => {
    const client = makeFakeClient('a');
    const target = makeSWTarget([client]);
    const originalFetch = target.fetch;
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    const cfg: ChaosConfig = {
      network: {
        failures: [{ urlPattern: '/api', statusCode: 503, probability: 1.0 }],
      },
      seed: 42,
    };

    target.dispatchMessage({ __chaosMakerConfig: cfg });

    // Give matchAll promise a chance to resolve for broadcasts.
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.isRunning()).toBe(true);
    expect(handle.getSeed()).toBe(42);
    expect(target.fetch).not.toBe(originalFetch);

    const response = await target.fetch('/api/data');
    expect(response.status).toBe(503);

    // Allow broadcast of failure event.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const events = client.messages.filter(
      (m): m is { __chaosMakerSWEvent: true; event: ChaosEvent } =>
        typeof m === 'object' && m !== null && '__chaosMakerSWEvent' in m,
    );
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((m) => m.event.type === 'network:failure' && m.event.applied)).toBe(true);

    handle.uninstall();
    // After uninstall the original fetch is restored.
    expect(target.fetch).toBe(originalFetch);
  });

  it('sends ack over MessageChannel port when provided', async () => {
    const target = makeSWTarget([]);
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    const portMessages: unknown[] = [];
    const port = { postMessage(m: unknown) { portMessages.push(m); } };

    const cfg: ChaosConfig = {
      network: { failures: [{ urlPattern: '/x', statusCode: 500, probability: 1 }] },
      seed: 7,
    };
    target.dispatchMessage({ __chaosMakerConfig: cfg }, [port]);

    expect(portMessages).toHaveLength(1);
    const ack = portMessages[0] as { __chaosMakerAck: boolean; seed: number; running: boolean };
    expect(ack.__chaosMakerAck).toBe(true);
    expect(ack.seed).toBe(7);
    expect(ack.running).toBe(true);
    handle.uninstall();
  });

  it('stops chaos when a stop message arrives', async () => {
    const target = makeSWTarget([]);
    const originalFetch = target.fetch;
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    const cfg: ChaosConfig = {
      network: { failures: [{ urlPattern: '/api', statusCode: 500, probability: 1 }] },
      seed: 1,
    };
    target.dispatchMessage({ __chaosMakerConfig: cfg });
    expect(handle.isRunning()).toBe(true);

    target.dispatchMessage({ __chaosMakerStop: true });
    expect(handle.isRunning()).toBe(false);
    expect(handle.getSeed()).toBeNull();
    expect(target.fetch).toBe(originalFetch);
    handle.uninstall();
  });

  it('can stop and clear remote state through the message channel', async () => {
    const target = makeSWTarget([]);
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    target.dispatchMessage({
      __chaosMakerConfig: {
        network: { failures: [{ urlPattern: '/api', statusCode: 500, probability: 1 }] },
        seed: 10,
      } satisfies ChaosConfig,
    });
    await target.fetch('/api/x');
    expect(handle.getLog().length).toBeGreaterThan(0);

    const stopMessages: unknown[] = [];
    target.dispatchMessage({ __chaosMakerStop: true }, [{ postMessage: (m: unknown) => stopMessages.push(m) }]);
    expect(handle.isRunning()).toBe(false);
    expect(handle.getSeed()).toBeNull();
    expect((stopMessages[0] as { running: boolean }).running).toBe(false);

    const clearMessages: unknown[] = [];
    target.dispatchMessage({ __chaosMakerClearLog: true }, [{ postMessage: (m: unknown) => clearMessages.push(m) }]);
    expect(handle.getLog()).toHaveLength(0);
    expect((clearMessages[0] as { running: boolean }).running).toBe(false);
    handle.uninstall();
  });

  it('returns the event log in response to a getLog message via port', async () => {
    const target = makeSWTarget([]);
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    const cfg: ChaosConfig = {
      network: { failures: [{ urlPattern: '/api', statusCode: 503, probability: 1 }] },
      seed: 3,
    };
    target.dispatchMessage({ __chaosMakerConfig: cfg });

    await target.fetch('/api/a');
    await target.fetch('/api/b');

    const portMessages: unknown[] = [];
    const port = { postMessage(m: unknown) { portMessages.push(m); } };
    target.dispatchMessage({ __chaosMakerGetLog: true }, [port]);

    const reply = portMessages.find(
      (m): m is { __chaosMakerLog: true; log: ChaosEvent[] } =>
        typeof m === 'object' && m !== null && '__chaosMakerLog' in m,
    );
    expect(reply).toBeDefined();
    expect(reply!.log.length).toBeGreaterThanOrEqual(2);
    expect(reply!.log.every((e) => e.type === 'network:failure')).toBe(true);
    handle.uninstall();
  });

  it('clears the log on __chaosMakerClearLog and acks running status', async () => {
    const target = makeSWTarget([]);
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    const cfg: ChaosConfig = {
      network: { failures: [{ urlPattern: '/api', statusCode: 500, probability: 1 }] },
      seed: 9,
    };
    target.dispatchMessage({ __chaosMakerConfig: cfg });
    await target.fetch('/api/x');
    expect(handle.getLog().length).toBeGreaterThan(0);

    const portMessages: unknown[] = [];
    const port = { postMessage(m: unknown) { portMessages.push(m); } };
    target.dispatchMessage({ __chaosMakerClearLog: true }, [port]);
    expect(handle.getLog()).toHaveLength(0);
    const ack = portMessages[0] as { __chaosMakerAck: true; running: boolean };
    expect(ack.running).toBe(true);
    handle.uninstall();
  });

  it('broadcasts events to every client returned by matchAll', async () => {
    const a = makeFakeClient('a');
    const b = makeFakeClient('b');
    const target = makeSWTarget([a, b]);
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    target.dispatchMessage({
      __chaosMakerConfig: {
        network: { failures: [{ urlPattern: '/api', statusCode: 500, probability: 1 }] },
        seed: 11,
      } satisfies ChaosConfig,
    });

    await target.fetch('/api/data');
    // Event broadcasts happen after matchAll promise resolves.
    await new Promise((r) => setTimeout(r, 0));

    const pickEvents = (c: FakeClient) =>
      c.messages.filter(
        (m): m is { __chaosMakerSWEvent: true; event: ChaosEvent } =>
          typeof m === 'object' && m !== null && '__chaosMakerSWEvent' in m,
      );

    expect(pickEvents(a).length).toBeGreaterThanOrEqual(1);
    expect(pickEvents(b).length).toBeGreaterThanOrEqual(1);
    handle.uninstall();
  });

  it('starts eagerly from self.__CHAOS_CONFIG__ when source = self-global', async () => {
    const target = makeSWTarget([]);
    target.__CHAOS_CONFIG__ = {
      network: { failures: [{ urlPattern: '/api', statusCode: 418, probability: 1 }] },
      seed: 21,
    };
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW({ source: 'self-global' });

    expect(handle.isRunning()).toBe(true);
    expect(handle.getSeed()).toBe(21);
    const response = await target.fetch('/api/x');
    expect(response.status).toBe(418);
    handle.uninstall();
  });

  it('replacing config mid-run resets counters and seed', async () => {
    const target = makeSWTarget([]);
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    target.dispatchMessage({
      __chaosMakerConfig: {
        network: { failures: [{ urlPattern: '/api', statusCode: 500, probability: 1, onNth: 2 }] },
        seed: 100,
      } satisfies ChaosConfig,
    });

    // First request: onNth=2 skips; second request: 500.
    await target.fetch('/api/1');
    const r2 = await target.fetch('/api/2');
    expect(r2.status).toBe(500);

    // Reconfigure  -  counter must reset so the new onNth=2 still fires on the
    // 2nd *post-reconfigure* request, not the 2nd request overall.
    target.dispatchMessage({
      __chaosMakerConfig: {
        network: { failures: [{ urlPattern: '/api', statusCode: 418, probability: 1, onNth: 2 }] },
        seed: 200,
      } satisfies ChaosConfig,
    });
    expect(handle.getSeed()).toBe(200);

    await target.fetch('/api/1');
    const rAfter = await target.fetch('/api/2');
    expect(rAfter.status).toBe(418);
    handle.uninstall();
  });

  describe('debug mode', () => {
    // Restore console.debug spies in one place so a failed assertion in any
    // test below does not leak the spy into the next test.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('broadcasts a sw:config-applied lifecycle debug event when debug:true', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const client = makeFakeClient('c1');
      const target = makeSWTarget([client]);
      const { installChaosSW } = await importSwWithTarget(target);
      installChaosSW({ source: 'message' });

      target.dispatchMessage({
        __chaosMakerConfig: { debug: true } satisfies ChaosConfig,
      });
      // Yield once for client.postMessage scheduling.
      await Promise.resolve();
      await Promise.resolve();

      const swEvents = client.messages.filter(
        (m) => (m as { __chaosMakerSWEvent?: boolean }).__chaosMakerSWEvent,
      ) as { event: ChaosEvent }[];
      const debugEvents = swEvents.filter((m) => m.event.type === 'debug');
      expect(debugEvents.length).toBeGreaterThanOrEqual(1);
      expect(debugEvents.some(
        (m) => m.event.detail.stage === 'lifecycle' && m.event.detail.phase === 'sw:config-applied',
      )).toBe(true);
      // Console mirror used the SW prefix.
      expect(debugSpy.mock.calls.some(
        (args) => typeof args[0] === 'string' && (args[0] as string).startsWith('[Chaos SW] '),
      )).toBe(true);
    });

    it('broadcasts sw:group-toggled when toggling a group while debug is on', async () => {
      vi.spyOn(console, 'debug').mockImplementation(() => {});
      const client = makeFakeClient('c1');
      const target = makeSWTarget([client]);
      const { installChaosSW } = await importSwWithTarget(target);
      installChaosSW({ source: 'message' });

      target.dispatchMessage({
        __chaosMakerConfig: { debug: true, groups: [{ name: 'payments', enabled: true }] } satisfies ChaosConfig,
      });
      await Promise.resolve();
      await Promise.resolve();
      client.messages.length = 0;

      target.dispatchMessage({
        __chaosMakerToggleGroup: { name: 'payments', enabled: false },
      });
      await Promise.resolve();
      await Promise.resolve();

      const swEvents = client.messages.filter(
        (m) => (m as { __chaosMakerSWEvent?: boolean }).__chaosMakerSWEvent,
      ) as { event: ChaosEvent }[];
      const toggleDbg = swEvents.find(
        (m) => m.event.type === 'debug' && m.event.detail.phase === 'sw:group-toggled',
      );
      expect(toggleDbg?.event.detail.groupName).toBe('payments');
      // the toggle debug payload must carry the new state so
      // consumers can pivot enable vs disable on the debug stream alone.
      expect(toggleDbg?.event.detail.enabled).toBe(false);
    });

    it('drops the SW logger after stop so a stale toggle cannot fire debug events', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const client = makeFakeClient('c1');
      const target = makeSWTarget([client]);
      const { installChaosSW } = await importSwWithTarget(target);
      installChaosSW({ source: 'message' });

      target.dispatchMessage({
        __chaosMakerConfig: { debug: true, groups: [{ name: 'payments', enabled: true }] } satisfies ChaosConfig,
      });
      await Promise.resolve();
      await Promise.resolve();
      target.dispatchMessage({ __chaosMakerStop: true });
      await Promise.resolve();
      await Promise.resolve();
      // Snapshot what's been seen so far, then clear so the next assertion
      // only inspects post-stop activity.
      client.messages.length = 0;
      debugSpy.mockClear();

      // Out-of-band toggle after the engine is stopped: must NOT emit any
      // type:'debug' event to clients OR call console.debug.
      target.dispatchMessage({
        __chaosMakerToggleGroup: { name: 'payments', enabled: false },
      });
      await Promise.resolve();
      await Promise.resolve();

      const swEvents = client.messages.filter(
        (m) => (m as { __chaosMakerSWEvent?: boolean }).__chaosMakerSWEvent,
      ) as { event: ChaosEvent }[];
      const debugEvents = swEvents.filter((m) => m.event.type === 'debug');
      expect(debugEvents).toHaveLength(0);
      const chaosDebugLines = debugSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && (args[0] as string).startsWith('[Chaos SW] '),
      );
      expect(chaosDebugLines).toHaveLength(0);
    });
  });
});
