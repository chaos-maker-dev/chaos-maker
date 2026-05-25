import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  injectChaos,
  removeChaos,
  removeSWChaos,
  getChaosLog,
  getChaosSeed,
  useChaos,
  type ChaosPage,
} from '../src/index';

function makeFakePage(): {
  page: ChaosPage;
  newDocumentCalls: Array<{ fn: unknown; args: unknown[] }>;
  evaluateCalls: Array<{ fn: unknown; args: unknown[] }>;
} {
  const newDocumentCalls: Array<{ fn: unknown; args: unknown[] }> = [];
  const evaluateCalls: Array<{ fn: unknown; args: unknown[] }> = [];
  const page: ChaosPage = {
    async evaluateOnNewDocument(fn, ...args) {
      newDocumentCalls.push({ fn, args });
      return undefined;
    },
    async evaluate(fn, ...args) {
      evaluateCalls.push({ fn, args });
      return undefined as never;
    },
    async goto() {
      return undefined;
    },
  };
  return { page, newDocumentCalls, evaluateCalls };
}

describe('@chaos-maker/puppeteer', () => {
  let fake: ReturnType<typeof makeFakePage>;

  beforeEach(() => {
    fake = makeFakePage();
  });

  describe('injectChaos', () => {
    it('calls evaluateOnNewDocument twice  -  once for config, once for UMD', async () => {
      await injectChaos(fake.page, {
        network: { failures: [{ urlPattern: '/api', statusCode: 500, probability: 1 }] },
      });
      expect(fake.newDocumentCalls).toHaveLength(2);
    });

    it('first call is a function (config injection)', async () => {
      await injectChaos(fake.page, {});
      expect(typeof fake.newDocumentCalls[0].fn).toBe('function');
    });

    it('second call is the UMD source string', async () => {
      await injectChaos(fake.page, {});
      expect(typeof fake.newDocumentCalls[1].fn).toBe('string');
      expect((fake.newDocumentCalls[1].fn as string).length).toBeGreaterThan(100);
    });

    it('passes config as second argument to first evaluateOnNewDocument call', async () => {
      const config = { network: { failures: [{ urlPattern: '/api', statusCode: 503, probability: 1 }] } };
      await injectChaos(fake.page, config);
      expect(fake.newDocumentCalls[0].args[0]).toEqual(config);
    });
  });

  describe('removeChaos', () => {
    it('calls evaluate once to stop chaos', async () => {
      await removeChaos(fake.page);
      expect(fake.evaluateCalls).toHaveLength(1);
    });

    it('swallows errors when page is closed', async () => {
      const closedPage: ChaosPage = {
        evaluateOnNewDocument: vi.fn(),
        evaluate: vi.fn().mockRejectedValue(new Error('Target closed')),
        goto: vi.fn(),
      };
      await expect(removeChaos(closedPage)).resolves.toBeUndefined();
    });

    it('removes tracked init scripts on cleanup (Puppeteer 22+ handle shape)', async () => {
      const removed: string[] = [];
      let next = 0;
      const page: ChaosPage = {
        async evaluateOnNewDocument() {
          return { identifier: `script-${++next}` };
        },
        async evaluate() {
          return undefined as never;
        },
        async goto() {
          return undefined;
        },
        async removeScriptToEvaluateOnNewDocument(id: string) {
          removed.push(id);
        },
      };
      await injectChaos(page, {});
      await removeChaos(page);
      expect(removed).toEqual(['script-1', 'script-2']);
    });

    it('is a no-op when page lacks removeScriptToEvaluateOnNewDocument', async () => {
      // Older Puppeteer / puppeteer-core forks may not expose the helper  - 
      // cleanup must still stop chaos without throwing.
      await injectChaos(fake.page, {});
      await expect(removeChaos(fake.page)).resolves.toBeUndefined();
    });
  });

  describe('getChaosLog', () => {
    it('returns evaluate result as-is', async () => {
      const expected = [{ type: 'network:failure', applied: true }];
      const page: ChaosPage = {
        evaluateOnNewDocument: vi.fn(),
        evaluate: vi.fn().mockResolvedValue(expected),
        goto: vi.fn(),
      };
      const log = await getChaosLog(page);
      expect(log).toBe(expected);
    });
  });

  describe('getChaosSeed', () => {
    it('returns seed from evaluate result', async () => {
      const page: ChaosPage = {
        evaluateOnNewDocument: vi.fn(),
        evaluate: vi.fn().mockResolvedValue(42),
        goto: vi.fn(),
      };
      const seed = await getChaosSeed(page);
      expect(seed).toBe(42);
    });

    it('returns null when chaos not active', async () => {
      const page: ChaosPage = {
        evaluateOnNewDocument: vi.fn(),
        evaluate: vi.fn().mockResolvedValue(null),
        goto: vi.fn(),
      };
      const seed = await getChaosSeed(page);
      expect(seed).toBeNull();
    });
  });

  describe('useChaos', () => {
    it('returns a teardown function', async () => {
      const teardown = await useChaos(fake.page, {});
      expect(typeof teardown).toBe('function');
    });

    it('teardown calls removeChaos (evaluate)', async () => {
      const teardown = await useChaos(fake.page, {});
      await teardown();
      expect(fake.evaluateCalls).toHaveLength(1);
    });
  });

  describe('removeSWChaos', () => {
    afterEach(() => {
      delete (globalThis as unknown as Record<string, unknown>).__chaosMakerSWBridge;
    });

    it('clears page and worker logs after stop', async () => {
      const stop = vi.fn(async () => undefined);
      const clearLocalLog = vi.fn();
      const clearRemoteLog = vi.fn(async () => undefined);
      (globalThis as unknown as Record<string, unknown>).__chaosMakerSWBridge = {
        stop,
        clearLocalLog,
        clearRemoteLog,
      };
      const page: ChaosPage = {
        evaluateOnNewDocument: vi.fn(),
        async evaluate(fn, ...args) {
          return (fn as (...innerArgs: unknown[]) => unknown)(...args) as never;
        },
        goto: vi.fn(),
      };

      await removeSWChaos(page, { timeoutMs: 321 });

      expect(stop).toHaveBeenCalledWith(321);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(clearLocalLog).toHaveBeenCalledTimes(1);
      expect(clearRemoteLog).toHaveBeenCalledWith(321);
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(clearLocalLog.mock.invocationCallOrder[0]);
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(clearRemoteLog.mock.invocationCallOrder[0]);
    });

    it('clears page and worker logs when stop rejects', async () => {
      const stop = vi.fn(async () => {
        throw new Error('stop failed');
      });
      const clearLocalLog = vi.fn();
      const clearRemoteLog = vi.fn(async () => undefined);
      (globalThis as unknown as Record<string, unknown>).__chaosMakerSWBridge = {
        stop,
        clearLocalLog,
        clearRemoteLog,
      };
      const page: ChaosPage = {
        evaluateOnNewDocument: vi.fn(),
        async evaluate(fn, ...args) {
          return (fn as (...innerArgs: unknown[]) => unknown)(...args) as never;
        },
        goto: vi.fn(),
      };

      await expect(removeSWChaos(page, { timeoutMs: 321 })).resolves.toBeUndefined();

      expect(stop).toHaveBeenCalledWith(321);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(clearLocalLog).toHaveBeenCalledTimes(1);
      expect(clearRemoteLog).toHaveBeenCalledWith(321);
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(clearLocalLog.mock.invocationCallOrder[0]);
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(clearRemoteLog.mock.invocationCallOrder[0]);
    });
  });
});
