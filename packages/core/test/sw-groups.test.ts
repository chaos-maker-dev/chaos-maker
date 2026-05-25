import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChaosConfig, ChaosEvent } from '../src';

/**
 * SW group tests.
 *
 * SW configs may carry `group: ...` on rules, the SW state owns a
 * `RuleGroupRegistry`, disabled groups block chaos, and
 * `__chaosMakerToggleGroup` toggles runtime state without restarting.
 */

type MessageListener = (event: { data: unknown; ports?: unknown[] }) => void;

interface FakeClient {
  id: string;
  messages: unknown[];
  postMessage(m: unknown): void;
}

function makeFakeClient(id: string): FakeClient {
  return {
    id,
    messages: [],
    postMessage(m) { this.messages.push(m); },
  };
}

interface SWLikeTarget {
  fetch: typeof globalThis.fetch;
  WebSocket?: typeof WebSocket;
  clients: { matchAll: () => Promise<readonly FakeClient[]> };
  __messageListeners: Set<MessageListener>;
  addEventListener: (type: string, fn: MessageListener) => void;
  removeEventListener: (type: string, fn: MessageListener) => void;
  dispatchMessage: (data: unknown, ports?: unknown[]) => void;
}

function makePort(): { messages: unknown[]; postMessage(m: unknown): void } {
  return {
    messages: [],
    postMessage(m) { this.messages.push(m); },
  };
}

function makeSWTarget(clients: FakeClient[]): SWLikeTarget {
  const listeners = new Set<MessageListener>();
  return {
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
}

async function importSwWithTarget(target: SWLikeTarget): Promise<typeof import('../src/sw')> {
  const INSTALL_MARK = Symbol.for('chaos-maker.sw.installed');
  delete (target as unknown as Record<symbol, unknown>)[INSTALL_MARK];
  vi.stubGlobal('self', target);
  return import('../src/sw');
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SW chaos - rule groups', () => {
  let origSelf: unknown;
  beforeEach(() => {
    vi.resetModules();
    origSelf = (globalThis as Record<string, unknown>).self;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    (globalThis as Record<string, unknown>).self = origSelf;
  });

  it('a config with `groups: [{name, enabled:false}]` blocks the matching rule and emits a single rule-group:gated event', async () => {
    const client = makeFakeClient('a');
    const target = makeSWTarget([client]);
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    const cfg: ChaosConfig = {
      groups: [{ name: 'payments', enabled: false }],
      network: {
        failures: [
          { urlPattern: '/api/pay', statusCode: 503, probability: 1, group: 'payments' },
        ],
      },
      seed: 42,
    };
    target.dispatchMessage({ __chaosMakerConfig: cfg });
    await flushMicrotasks();

    const r1 = await target.fetch('/api/pay');
    const r2 = await target.fetch('/api/pay');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const log = handle.getLog();
    const gated = log.filter((e) => e.type === 'rule-group:gated');
    expect(gated.length).toBe(1);
    expect(gated[0].detail.groupName).toBe('payments');
    expect(gated[0].applied).toBe(false);

    handle.uninstall();
  });

  it('rules with no group continue firing while another group is disabled', async () => {
    const target = makeSWTarget([]);
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    const cfg: ChaosConfig = {
      groups: [{ name: 'analytics', enabled: false }],
      network: {
        failures: [
          { urlPattern: '/api/data', statusCode: 500, probability: 1 }, // ungrouped
          { urlPattern: '/api/track', statusCode: 503, probability: 1, group: 'analytics' },
        ],
      },
      seed: 1,
    };
    target.dispatchMessage({ __chaosMakerConfig: cfg });
    await flushMicrotasks();

    const ungrouped = await target.fetch('/api/data');
    const gatedRes = await target.fetch('/api/track');
    expect(ungrouped.status).toBe(500);
    expect(gatedRes.status).toBe(200);

    handle.uninstall();
  });

  it('startEngine seeds groups from rule references  -  referenced groups become observable post-config', async () => {
    const client = makeFakeClient('a');
    const target = makeSWTarget([client]);
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    const cfg: ChaosConfig = {
      network: {
        failures: [
          { urlPattern: '/api/pay', statusCode: 500, probability: 1, group: 'payments' },
        ],
      },
      seed: 9,
    };
    target.dispatchMessage({ __chaosMakerConfig: cfg });
    await flushMicrotasks();

    // The first request to /api/pay still applies chaos because `payments`
    // was auto-registered as default-on.
    const r = await target.fetch('/api/pay');
    expect(r.status).toBe(500);

    handle.uninstall();
  });

  it('__chaosMakerToggleGroup toggles groups without resetting counters', async () => {
    const target = makeSWTarget([]);
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    const cfg: ChaosConfig = {
      network: {
        failures: [
          { urlPattern: '/api/pay', statusCode: 500, probability: 1, afterN: 1, group: 'payments' },
        ],
      },
      seed: 12,
    };
    target.dispatchMessage({ __chaosMakerConfig: cfg });
    await flushMicrotasks();

    const disablePort = makePort();
    target.dispatchMessage({ __chaosMakerToggleGroup: { name: 'payments', enabled: false } }, [disablePort]);
    expect(disablePort.messages).toEqual([
      { __chaosMakerAck: true, running: true },
    ]);

    const warmup = await target.fetch('/api/pay');
    const gated = await target.fetch('/api/pay');
    expect(warmup.status).toBe(200);
    expect(gated.status).toBe(200);
    expect(handle.getLog().some((e) => e.type === 'rule-group:gated' && e.detail.groupName === 'payments')).toBe(true);

    const enablePort = makePort();
    target.dispatchMessage({ __chaosMakerToggleGroup: { name: 'payments', enabled: true } }, [enablePort]);
    expect(enablePort.messages).toEqual([
      { __chaosMakerAck: true, running: true },
    ]);

    const applied = await target.fetch('/api/pay');
    expect(applied.status).toBe(500);

    handle.uninstall();
  });

  it('__chaosMakerToggleGroup trims names and rejects empty normalized names', async () => {
    const target = makeSWTarget([]);
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    const cfg: ChaosConfig = {
      network: {
        failures: [
          { urlPattern: '/api/pay', statusCode: 500, probability: 1, group: 'payments' },
        ],
      },
      seed: 13,
    };
    target.dispatchMessage({ __chaosMakerConfig: cfg });
    await flushMicrotasks();

    const emptyPort = makePort();
    target.dispatchMessage({ __chaosMakerToggleGroup: { name: '   ', enabled: false } }, [emptyPort]);
    expect(emptyPort.messages).toEqual([
      { __chaosMakerAck: true, running: true },
    ]);
    expect(handle.getLog().some((e) => e.type === 'rule-group:disabled')).toBe(false);

    const disablePort = makePort();
    target.dispatchMessage({ __chaosMakerToggleGroup: { name: ' payments ', enabled: false } }, [disablePort]);
    expect(disablePort.messages).toEqual([
      { __chaosMakerAck: true, running: true },
    ]);

    const gated = await target.fetch('/api/pay');
    expect(gated.status).toBe(200);
    expect(handle.getLog().some((e) => e.type === 'rule-group:gated' && e.detail.groupName === 'payments')).toBe(true);

    handle.uninstall();
  });

  it('broadcasts rule-group:gated events to controlled clients', async () => {
    const client = makeFakeClient('a');
    const target = makeSWTarget([client]);
    const { installChaosSW } = await importSwWithTarget(target);
    const handle = installChaosSW();

    const cfg: ChaosConfig = {
      groups: [{ name: 'payments', enabled: false }],
      network: {
        failures: [{ urlPattern: '/api/pay', statusCode: 500, probability: 1, group: 'payments' }],
      },
      seed: 11,
    };
    target.dispatchMessage({ __chaosMakerConfig: cfg });
    await flushMicrotasks();
    await target.fetch('/api/pay');
    await flushMicrotasks();

    const events = client.messages.filter(
      (m): m is { __chaosMakerSWEvent: true; event: ChaosEvent } =>
        typeof m === 'object' && m !== null && '__chaosMakerSWEvent' in m,
    );
    const gatedEvents = events.filter((m) => m.event.type === 'rule-group:gated');
    expect(gatedEvents.length).toBe(1);

    handle.uninstall();
  });
});
