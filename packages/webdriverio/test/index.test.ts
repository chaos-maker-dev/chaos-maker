import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  injectChaos,
  removeChaos,
  removeSWChaos,
  getChaosLog,
  getChaosSeed,
  registerChaosCommands,
  type ChaosBrowser,
} from '../src/index';

function makeFakeBrowser(): {
  browser: ChaosBrowser;
  executeCalls: Array<{ fn: unknown; args: unknown[] }>;
  addCommandCalls: Array<{ name: string; fn: (...args: unknown[]) => unknown }>;
} {
  const executeCalls: Array<{ fn: unknown; args: unknown[] }> = [];
  const addCommandCalls: Array<{ name: string; fn: (...args: unknown[]) => unknown }> = [];
  const browser: ChaosBrowser = {
    async execute(fn, ...args) {
      executeCalls.push({ fn, args });
      // Default stub: behave like "chaos bootstrapped successfully" for injectChaos,
      // which checks for a truthy result to fail fast on CSP/bootstrap errors.
      return true as never;
    },
    addCommand(name, fn) {
      addCommandCalls.push({ name, fn });
    },
  };
  return { browser, executeCalls, addCommandCalls };
}

describe('@chaos-maker/webdriverio', () => {
  let fake: ReturnType<typeof makeFakeBrowser>;

  beforeEach(() => {
    fake = makeFakeBrowser();
  });

  describe('injectChaos', () => {
    it('executes a single script argument that prepends the config assignment to the UMD bundle', async () => {
      await injectChaos(fake.browser, {
        network: { failures: [{ urlPattern: '/api', statusCode: 500, probability: 1 }] },
      });
      expect(fake.executeCalls).toHaveLength(1);
      const [scriptSource] = fake.executeCalls[0].args as [string];
      expect(typeof scriptSource).toBe('string');
      expect(scriptSource).toMatch(/^window\.__CHAOS_CONFIG__ = /);
      expect(scriptSource.length).toBeGreaterThan(100); // real UMD bundle, not empty
      // config is embedded as a JSON literal on the first line
      const firstLine = scriptSource.split('\n', 1)[0];
      const configJson = firstLine.replace(/^window\.__CHAOS_CONFIG__ = /, '').replace(/;$/, '');
      expect(JSON.parse(configJson)).toMatchObject({
        network: { failures: [{ urlPattern: '/api', statusCode: 500 }] },
      });
    });

    it('passes the script as a function, not a raw string  -  lets WDIO handle IIFE wrapping', async () => {
      await injectChaos(fake.browser, {});
      expect(fake.executeCalls).toHaveLength(1);
      expect(typeof fake.executeCalls[0].fn).toBe('function');
    });

    it('throws when bootstrap check reports chaos did not start (e.g. CSP blocked inline script)', async () => {
      const browser: ChaosBrowser = {
        execute: vi.fn().mockResolvedValue(false),
      };
      await expect(injectChaos(browser, {})).rejects.toThrow(/did not start/);
    });
  });

  describe('removeChaos / getChaosLog / getChaosSeed', () => {
    it('removeChaos issues a single execute call', async () => {
      await removeChaos(fake.browser);
      expect(fake.executeCalls).toHaveLength(1);
    });

    it('removeChaos swallows closed-session evaluation errors', async () => {
      const browser: ChaosBrowser = {
        execute: vi.fn().mockRejectedValue(new Error('Session closed')),
      };
      await expect(removeChaos(browser)).resolves.toBeUndefined();
    });

    it('removeChaos rethrows non-session evaluation errors', async () => {
      const browser: ChaosBrowser = {
        execute: vi.fn().mockRejectedValue(new Error('chaos stop failed')),
      };
      await expect(removeChaos(browser)).rejects.toThrow('chaos stop failed');
    });

    it('getChaosLog returns browser execute result as-is', async () => {
      const expected = [{ type: 'network:failure', applied: true }];
      const browser: ChaosBrowser = {
        execute: vi.fn().mockResolvedValue(expected),
      };
      const log = await getChaosLog(browser);
      expect(log).toBe(expected);
    });

    it('getChaosSeed returns browser execute result as-is', async () => {
      const browser: ChaosBrowser = {
        execute: vi.fn().mockResolvedValue(42),
      };
      const seed = await getChaosSeed(browser);
      expect(seed).toBe(42);
    });

    it('getChaosSeed returns null when chaos is not installed', async () => {
      const browser: ChaosBrowser = {
        execute: vi.fn().mockResolvedValue(null),
      };
      const seed = await getChaosSeed(browser);
      expect(seed).toBeNull();
    });
  });

  describe('registerChaosCommands', () => {
    it('registers all browser-side commands on the browser', () => {
      registerChaosCommands(fake.browser);
      const names = fake.addCommandCalls.map((c) => c.name);
      expect(names).toEqual([
        'injectChaos',
        'removeChaos',
        'getChaosLog',
        'getChaosSeed',
        'enableGroup',
        'disableGroup',
      ]);
    });

    it('throws when addCommand is missing', () => {
      const noAddCommand: ChaosBrowser = {
        execute: vi.fn(),
      };
      expect(() => registerChaosCommands(noAddCommand)).toThrow(/addCommand/);
    });
  });

  describe('removeSWChaos', () => {
    it('clears page and worker logs after stop', async () => {
      const stop = vi.fn(async () => undefined);
      const clearLocalLog = vi.fn();
      const clearRemoteLog = vi.fn(async () => undefined);
      (globalThis as unknown as Record<string, unknown>).window = {
        __chaosMakerSWBridge: {
          stop,
          clearLocalLog,
          clearRemoteLog,
        },
      };
      const browser: ChaosBrowser = {
        async execute(fn, ...args) {
          return (fn as (...innerArgs: unknown[]) => unknown)(...args) as never;
        },
      };

      await removeSWChaos(browser, { timeoutMs: 456 });

      expect(stop).toHaveBeenCalledWith(456);
      expect(clearLocalLog).toHaveBeenCalledTimes(1);
      expect(clearRemoteLog).toHaveBeenCalledWith(456);
      delete (globalThis as unknown as Record<string, unknown>).window;
    });

    it('clears page and worker logs when stop rejects', async () => {
      const stop = vi.fn(async () => {
        throw new Error('stop failed');
      });
      const clearLocalLog = vi.fn();
      const clearRemoteLog = vi.fn(async () => undefined);
      (globalThis as unknown as Record<string, unknown>).window = {
        __chaosMakerSWBridge: {
          stop,
          clearLocalLog,
          clearRemoteLog,
        },
      };
      const browser: ChaosBrowser = {
        async execute(fn, ...args) {
          return (fn as (...innerArgs: unknown[]) => unknown)(...args) as never;
        },
      };

      await expect(removeSWChaos(browser, { timeoutMs: 456 })).resolves.toBeUndefined();

      expect(clearLocalLog).toHaveBeenCalledTimes(1);
      expect(clearRemoteLog).toHaveBeenCalledWith(456);
      delete (globalThis as unknown as Record<string, unknown>).window;
    });
  });
});
