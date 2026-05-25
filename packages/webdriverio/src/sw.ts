import type { ChaosConfig, ChaosEvent, ValidateChaosConfigOptions } from '@chaos-maker/core';
import { validateChaosConfig, SW_BRIDGE_SOURCE } from '@chaos-maker/core';
import type { ChaosBrowser } from './index';

export interface SWChaosOptions {
  /**
   * Milliseconds to wait for `navigator.serviceWorker.controller` + the SW's
   * ack message. Defaults to `10000`.
   */
  timeoutMs?: number;
  /**
   * Forwarded to `validateChaosConfig` before the config is posted
   * to the SW. Malformed configs throw a `ChaosConfigError` from Node.
   */
  validation?: ValidateChaosConfigOptions;
}

export interface InjectSWChaosResult {
  seed: number | null;
}

const DEFAULT_SW_TOGGLE_TIMEOUT = 2_000;

/**
 * Inject chaos into the active page's Service Worker.
 *
 * Call **after** `browser.url(...)` so the SW has registered and claimed the
 * page. The target SW must `importScripts('/chaos-maker-sw.js')` (classic) or
 * call `installChaosSW()` (module)  -  see README for fixture examples.
 *
 * @example
 * ```ts
 * await browser.url('/');
 * await injectSWChaos(browser, {
 *   network: { failures: [{ urlPattern: '/api', statusCode: 503, probability: 1 }] },
 * });
 * ```
 */
export async function injectSWChaos(
  browser: ChaosBrowser,
  config: ChaosConfig,
  opts: SWChaosOptions = {},
): Promise<InjectSWChaosResult> {
  const validated = validateChaosConfig(config, opts.validation);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // Install bridge source via `execute` (sync eval + inline <script> tag),
  // then invoke `apply` via a second `execute` using async/await. WDIO v8
  // deprecated `executeAsync`  -  async callbacks work natively in `execute`.
  await browser.execute((src: string) => {
    const w = window as unknown as { __chaosMakerSWBridgeInstalled?: boolean };
    if (w.__chaosMakerSWBridgeInstalled) return;
    const script = document.createElement('script');
    script.textContent = src;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }, SW_BRIDGE_SOURCE);

  const result = await browser.execute(async (cfg: ChaosConfig, t: number) => {
    const bridge = (window as unknown as {
      __chaosMakerSWBridge?: {
        apply: (c: ChaosConfig, t: number) => Promise<{ seed: number | null }>;
      };
    }).__chaosMakerSWBridge;
    if (!bridge) throw new Error('[chaos-maker] SW bridge missing  -  install failed');
    return await bridge.apply(cfg, t);
  }, validated, timeoutMs);

  return result as InjectSWChaosResult;
}

/**
 * Stop SW chaos and clear the page-side log buffer.
 */
export async function removeSWChaos(browser: ChaosBrowser, opts: SWChaosOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  // Session may already be torn down when this runs from `afterTest`  -  a
  // transient browser error here would otherwise mask the failing assertion.
  try {
    await browser.execute(async (t: number) => {
      const bridge = (window as unknown as {
        __chaosMakerSWBridge?: {
          stop: (t: number) => Promise<unknown>;
          clearLocalLog: () => void;
          clearRemoteLog?: (t: number) => Promise<void>;
        };
      }).__chaosMakerSWBridge;
      if (!bridge) return;
      try {
        await bridge.stop(t);
      } finally {
        bridge.clearLocalLog();
        await bridge.clearRemoteLog?.(t).catch(() => undefined);
      }
    }, timeoutMs);
  } catch {
    // Session closed mid-teardown  -  nothing left to clean up.
  }
}

/**
 * Enable a rule group inside the active SW chaos engine. Posts
 * `__chaosMakerToggleGroup` over MessageChannel and resolves only after the SW
 * acks. Engine state and request counters are preserved (no restart).
 */
export async function enableSWGroup(
  browser: ChaosBrowser,
  name: string,
  opts: SWChaosOptions = {},
): Promise<void> {
  if (typeof name !== 'string') {
    throw new Error('[chaos-maker] group name must be a string');
  }
  const nameNorm = name.trim();
  if (!nameNorm) {
    throw new Error('[chaos-maker] group name cannot be empty');
  }
  await toggleSWGroup(browser, nameNorm, true, opts);
}

/** Disable a rule group inside the active SW chaos engine. */
export async function disableSWGroup(
  browser: ChaosBrowser,
  name: string,
  opts: SWChaosOptions = {},
): Promise<void> {
  if (typeof name !== 'string') {
    throw new Error('[chaos-maker] group name must be a string');
  }
  const nameNorm = name.trim();
  if (!nameNorm) {
    throw new Error('[chaos-maker] group name cannot be empty');
  }
  await toggleSWGroup(browser, nameNorm, false, opts);
}

async function toggleSWGroup(
  browser: ChaosBrowser,
  name: string,
  enabled: boolean,
  opts: SWChaosOptions,
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SW_TOGGLE_TIMEOUT;
  await browser.execute((src: string) => {
    const w = window as unknown as { __chaosMakerSWBridgeInstalled?: boolean };
    if (w.__chaosMakerSWBridgeInstalled) return;
    const script = document.createElement('script');
    script.textContent = src;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }, SW_BRIDGE_SOURCE);

  await browser.execute(
    async (n: string, e: boolean, t: number) => {
      const bridge = (window as unknown as {
        __chaosMakerSWBridge?: {
          toggleGroup: (n: string, e: boolean, t: number) => Promise<unknown>;
        };
      }).__chaosMakerSWBridge;
      if (!bridge) throw new Error('[chaos-maker] SW bridge missing  -  install failed');
      await bridge.toggleGroup(n, e, t);
    },
    name,
    enabled,
    timeoutMs,
  );
}

/** Read SW chaos events buffered on the page side. */
export async function getSWChaosLog(browser: ChaosBrowser): Promise<ChaosEvent[]> {
  return browser.execute(() => {
    const bridge = (window as unknown as {
      __chaosMakerSWBridge?: { getLocalLog: () => unknown[] };
    }).__chaosMakerSWBridge;
    return bridge ? (bridge.getLocalLog() as ChaosEvent[]) : [];
  });
}

/** Read SW chaos events directly from the SW's in-memory log. */
export async function getSWChaosLogFromSW(
  browser: ChaosBrowser,
  opts: SWChaosOptions = {},
): Promise<ChaosEvent[]> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const result = await browser.execute(async (t: number) => {
    const bridge = (window as unknown as {
      __chaosMakerSWBridge?: { getRemoteLog: (t: number) => Promise<unknown[]> };
    }).__chaosMakerSWBridge;
    if (!bridge) return [] as unknown[];
    return await bridge.getRemoteLog(t);
  }, timeoutMs);
  return result as ChaosEvent[];
}

/**
 * Register SW chaos commands (`browser.injectSWChaos`, etc.) on the browser
 * object. Call once during `before` hook. Safe to call alongside
 * {@link registerChaosCommands}.
 */
export function registerSWChaosCommands(browser: ChaosBrowser): void {
  if (!browser.addCommand) {
    throw new Error(
      '[chaos-maker] registerSWChaosCommands: browser object does not expose addCommand',
    );
  }
  browser.addCommand('injectSWChaos', async function (this: ChaosBrowser, ...args: unknown[]) {
    return injectSWChaos(this, args[0] as ChaosConfig, args[1] as SWChaosOptions | undefined);
  });
  browser.addCommand('removeSWChaos', async function (this: ChaosBrowser, ...args: unknown[]) {
    await removeSWChaos(this, args[0] as SWChaosOptions | undefined);
  });
  browser.addCommand('getSWChaosLog', async function (this: ChaosBrowser) {
    return getSWChaosLog(this);
  });
  browser.addCommand('getSWChaosLogFromSW', async function (this: ChaosBrowser, ...args: unknown[]) {
    return getSWChaosLogFromSW(this, args[0] as SWChaosOptions | undefined);
  });
  browser.addCommand('enableSWGroup', async function (this: ChaosBrowser, ...args: unknown[]) {
    await enableSWGroup(this, args[0] as string, args[1] as SWChaosOptions | undefined);
  });
  browser.addCommand('disableSWGroup', async function (this: ChaosBrowser, ...args: unknown[]) {
    await disableSWGroup(this, args[0] as string, args[1] as SWChaosOptions | undefined);
  });
}
