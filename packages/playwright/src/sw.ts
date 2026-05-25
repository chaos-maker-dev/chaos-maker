import type { Page } from '@playwright/test';
import type { ChaosConfig, ChaosEvent, ValidateChaosConfigOptions } from '@chaos-maker/core';
import { validateChaosConfig, SW_BRIDGE_SOURCE } from '@chaos-maker/core';

/**
 * Options accepted by {@link injectSWChaos} / {@link removeSWChaos} /
 * {@link getSWChaosLog}.
 */
export interface SWChaosOptions {
  /**
   * Maximum milliseconds to wait for `navigator.serviceWorker.controller` and
   * the SW's ack message. Defaults to `10000`. Raise for slow CI workers or
   * SWs that do heavy work during `install`.
   */
  timeoutMs?: number;
  /**
   * Forwarded to `validateChaosConfig` before the config is posted
   * to the SW. Malformed configs throw a `ChaosConfigError` from Node.
   */
  validation?: ValidateChaosConfigOptions;
}

export interface InjectSWChaosResult {
  /** Seed used by the PRNG inside the SW. `null` if the ack did not carry one. */
  seed: number | null;
}

const BRIDGE_INIT_KEY = Symbol.for('chaos-maker.playwright.sw.bridgeInit');

const DEFAULT_SW_TOGGLE_TIMEOUT = 2_000;

async function ensurePageBridge(page: Page): Promise<void> {
  // `addInitScript` is additive  -  call it at most once per Page to prevent
  // listener stacking across re-inject calls. The flag inside the script also
  // guards against double-install within a single document.
  if (!(page as unknown as Record<symbol, unknown>)[BRIDGE_INIT_KEY]) {
    await page.addInitScript({ content: SW_BRIDGE_SOURCE });
    (page as unknown as Record<symbol, unknown>)[BRIDGE_INIT_KEY] = true;
  }
  // Current document has already navigated  -  init script won't retro-fire, so
  // also evaluate the same source against the live document.
  await page.evaluate(SW_BRIDGE_SOURCE).catch(() => {
    // Page may not yet have committed (pre-goto usage). addInitScript covers
    // the next navigation; skip inline install silently.
  });
}

/**
 * Configure Service-Worker chaos for a Playwright page. Call **after**
 * `page.goto(...)` so there is a SW registration + controller to target.
 *
 * Requires the user's service worker to load the chaos SW bundle  -  typically
 * via `importScripts('/path/to/chaos-maker-sw.js')` (classic SW) or
 * `import { installChaosSW } from '@chaos-maker/core/sw'; installChaosSW();`
 * (module SW).
 *
 * @example
 * ```ts
 * await page.goto('/');
 * await injectSWChaos(page, {
 *   network: { failures: [{ urlPattern: '/api', statusCode: 503, probability: 1 }] },
 * });
 * ```
 */
export async function injectSWChaos(
  page: Page,
  config: ChaosConfig,
  opts: SWChaosOptions = {},
): Promise<InjectSWChaosResult> {
  const validated = validateChaosConfig(config, opts.validation);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  await ensurePageBridge(page);

  const result = await page.evaluate(
    async ({ cfg, timeoutMs }: { cfg: ChaosConfig; timeoutMs: number }) => {
      const bridge = (globalThis as unknown as {
        __chaosMakerSWBridge?: {
          apply: (c: ChaosConfig, t: number) => Promise<{ seed: number | null }>;
        };
      }).__chaosMakerSWBridge;
      if (!bridge) throw new Error('[chaos-maker] SW bridge missing from page  -  ensurePageBridge failed');
      return await bridge.apply(cfg, timeoutMs);
    },
    { cfg: validated, timeoutMs },
  );

  return result;
}

/**
 * Stop Service-Worker chaos for a Playwright page. Posts `__chaosMakerStop` to
 * the current controller and clears the page's in-memory log buffer.
 */
export async function removeSWChaos(page: Page, opts: SWChaosOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  await page.evaluate(
    async ({ timeoutMs }: { timeoutMs: number }) => {
      const bridge = (globalThis as unknown as {
        __chaosMakerSWBridge?: {
          stop: (t: number) => Promise<unknown>;
          clearLocalLog: () => void;
          clearRemoteLog?: (t: number) => Promise<void>;
        };
      }).__chaosMakerSWBridge;
      if (!bridge) return;
      try {
        await bridge.stop(timeoutMs);
      } finally {
        bridge.clearLocalLog();
        await bridge.clearRemoteLog?.(timeoutMs).catch(() => undefined);
      }
    },
    { timeoutMs },
  ).catch(() => {
    // Page may be closed during teardown  -  don't mask real failures.
  });
}

/**
 * Enable a rule group inside the active SW chaos engine. Posts
 * `__chaosMakerToggleGroup` over MessageChannel and resolves only after the SW
 * acks. Engine state and request counters are preserved (no restart).
 */
export async function enableSWGroup(page: Page, name: string, opts: SWChaosOptions = {}): Promise<void> {
  if (typeof name !== 'string') {
    throw new Error('[chaos-maker] group name must be a string');
  }
  const nameNorm = name.trim();
  if (!nameNorm) {
    throw new Error('[chaos-maker] group name cannot be empty');
  }
  await toggleSWGroup(page, nameNorm, true, opts);
}

/** Disable a rule group inside the active SW chaos engine. */
export async function disableSWGroup(page: Page, name: string, opts: SWChaosOptions = {}): Promise<void> {
  if (typeof name !== 'string') {
    throw new Error('[chaos-maker] group name must be a string');
  }
  const nameNorm = name.trim();
  if (!nameNorm) {
    throw new Error('[chaos-maker] group name cannot be empty');
  }
  await toggleSWGroup(page, nameNorm, false, opts);
}

async function toggleSWGroup(page: Page, name: string, enabled: boolean, opts: SWChaosOptions): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SW_TOGGLE_TIMEOUT;
  await ensurePageBridge(page);
  await page.evaluate(
    async ({ n, e, t }: { n: string; e: boolean; t: number }) => {
      const bridge = (globalThis as unknown as {
        __chaosMakerSWBridge?: {
          toggleGroup: (name: string, enabled: boolean, t: number) => Promise<unknown>;
        };
      }).__chaosMakerSWBridge;
      if (!bridge) throw new Error('[chaos-maker] SW bridge missing  -  ensurePageBridge failed');
      await bridge.toggleGroup(n, e, t);
    },
    { n: name, e: enabled, t: timeoutMs },
  );
}

/**
 * Read the chaos event log buffered on the page side. Every event emitted by
 * the SW is broadcast to all controlled clients and captured here.
 */
export async function getSWChaosLog(page: Page): Promise<ChaosEvent[]> {
  return page.evaluate(() => {
    const bridge = (globalThis as unknown as {
      __chaosMakerSWBridge?: { getLocalLog: () => ChaosEvent[] };
    }).__chaosMakerSWBridge;
    if (!bridge) return [] as ChaosEvent[];
    return bridge.getLocalLog();
  });
}

/**
 * Ask the SW for its in-memory log. Useful when debugging a race where the
 * page-side listener missed an early broadcast (e.g. first-paint navigation).
 * Prefer {@link getSWChaosLog} in normal assertions.
 */
export async function getSWChaosLogFromSW(page: Page, opts: SWChaosOptions = {}): Promise<ChaosEvent[]> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return page.evaluate(
    async ({ timeoutMs }: { timeoutMs: number }) => {
      const bridge = (globalThis as unknown as {
        __chaosMakerSWBridge?: { getRemoteLog: (t: number) => Promise<ChaosEvent[]> };
      }).__chaosMakerSWBridge;
      if (!bridge) return [] as ChaosEvent[];
      return bridge.getRemoteLog(timeoutMs);
    },
    { timeoutMs },
  );
}
