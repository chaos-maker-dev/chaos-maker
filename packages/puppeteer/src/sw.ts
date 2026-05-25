import type { ChaosConfig, ChaosEvent, ValidateChaosConfigOptions } from '@chaos-maker/core';
import { validateChaosConfig, SW_BRIDGE_SOURCE } from '@chaos-maker/core';
import type { ChaosPage } from './index';

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

const BRIDGE_INIT_KEY = Symbol.for('chaos-maker.puppeteer.sw.bridgeInit');

const DEFAULT_SW_TOGGLE_TIMEOUT = 2_000;

// Puppeteer messages raised when no document is committed / context is torn
// down. These are the only conditions under which we want `page.evaluate`
// to be a no-op here; anything else (CSP, syntax error, destroyed target
// mid-injection) is a real bug and must surface.
const EXPECTED_EVAL_ERRORS = [
  'Cannot find context',
  'Execution context was destroyed',
  'Target closed',
  'Session closed',
  'no frame for given id',
];

async function ensurePageBridge(page: ChaosPage): Promise<void> {
  // `evaluateOnNewDocument` is additive  -  dedupe per-page so listener sets
  // never stack across re-inject calls.
  const marked = (page as unknown as Record<symbol, unknown>)[BRIDGE_INIT_KEY];
  if (!marked) {
    await page.evaluateOnNewDocument(SW_BRIDGE_SOURCE);
    (page as unknown as Record<symbol, unknown>)[BRIDGE_INIT_KEY] = true;
  }
  // Current document has already committed  -  ensure bridge is live there too.
  try {
    await (page.evaluate(SW_BRIDGE_SOURCE) as Promise<unknown>);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!EXPECTED_EVAL_ERRORS.some((m) => msg.includes(m))) throw err;
    // Page has no committed doc yet  -  init script covers the first one.
  }
}

/**
 * Inject chaos into the active page's Service Worker.
 *
 * Call **after** `page.goto(...)` so the SW has registered and claimed the
 * page. The target SW must `importScripts('/chaos-maker-sw.js')` (classic) or
 * call `installChaosSW()` (module)  -  see README for fixture examples.
 */
export async function injectSWChaos(
  page: ChaosPage,
  config: ChaosConfig,
  opts: SWChaosOptions = {},
): Promise<InjectSWChaosResult> {
  const validated = validateChaosConfig(config, opts.validation);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  await ensurePageBridge(page);

  const result = await page.evaluate(
    async (cfg: unknown, t: unknown) => {
      const bridge = (globalThis as unknown as {
        __chaosMakerSWBridge?: {
          apply: (c: unknown, t: number) => Promise<{ seed: number | null }>;
        };
      }).__chaosMakerSWBridge;
      if (!bridge) throw new Error('[chaos-maker] SW bridge missing  -  ensurePageBridge failed');
      return await bridge.apply(cfg, t as number);
    },
    validated as unknown,
    timeoutMs as unknown,
  );
  return result as InjectSWChaosResult;
}

/** Stop SW chaos and clear the page-side log buffer. */
export async function removeSWChaos(page: ChaosPage, opts: SWChaosOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  try {
    await page.evaluate(
      async (t: unknown) => {
        const bridge = (globalThis as unknown as {
          __chaosMakerSWBridge?: {
            stop: (t: number) => Promise<unknown>;
            clearLocalLog: () => void;
            clearRemoteLog?: (t: number) => Promise<void>;
          };
        }).__chaosMakerSWBridge;
        if (!bridge) return;
        try {
          await bridge.stop(t as number);
        } finally {
          bridge.clearLocalLog();
          await bridge.clearRemoteLog?.(t as number).catch(() => undefined);
        }
      },
      timeoutMs as unknown,
    );
  } catch {
    // Page may be closed during teardown.
  }
}

/**
 * Enable a rule group inside the active SW chaos engine. Posts
 * `__chaosMakerToggleGroup` over MessageChannel and resolves only after the SW
 * acks. Engine state and request counters are preserved (no restart).
 */
export async function enableSWGroup(
  page: ChaosPage,
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
  await toggleSWGroup(page, nameNorm, true, opts);
}

/** Disable a rule group inside the active SW chaos engine. */
export async function disableSWGroup(
  page: ChaosPage,
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
  await toggleSWGroup(page, nameNorm, false, opts);
}

async function toggleSWGroup(
  page: ChaosPage,
  name: string,
  enabled: boolean,
  opts: SWChaosOptions,
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SW_TOGGLE_TIMEOUT;
  await ensurePageBridge(page);
  await page.evaluate(
    async (n: unknown, e: unknown, t: unknown) => {
      const bridge = (globalThis as unknown as {
        __chaosMakerSWBridge?: {
          toggleGroup: (n: string, e: boolean, t: number) => Promise<unknown>;
        };
      }).__chaosMakerSWBridge;
      if (!bridge) throw new Error('[chaos-maker] SW bridge missing  -  ensurePageBridge failed');
      await bridge.toggleGroup(n as string, e as boolean, t as number);
    },
    name as unknown,
    enabled as unknown,
    timeoutMs as unknown,
  );
}

/** Read SW chaos events buffered on the page side. */
export async function getSWChaosLog(page: ChaosPage): Promise<ChaosEvent[]> {
  return page.evaluate(() => {
    const bridge = (globalThis as unknown as {
      __chaosMakerSWBridge?: { getLocalLog: () => unknown[] };
    }).__chaosMakerSWBridge;
    return bridge ? (bridge.getLocalLog() as ChaosEvent[]) : ([] as ChaosEvent[]);
  }) as Promise<ChaosEvent[]>;
}

/** Read SW chaos events directly from the SW's in-memory log. */
export async function getSWChaosLogFromSW(
  page: ChaosPage,
  opts: SWChaosOptions = {},
): Promise<ChaosEvent[]> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const result = await page.evaluate(
    async (t: unknown) => {
      const bridge = (globalThis as unknown as {
        __chaosMakerSWBridge?: { getRemoteLog: (t: number) => Promise<unknown[]> };
      }).__chaosMakerSWBridge;
      if (!bridge) return [] as unknown[];
      return await bridge.getRemoteLog(t as number);
    },
    timeoutMs as unknown,
  );
  return result as ChaosEvent[];
}

/**
 * Helper for test frameworks that use `afterEach`/`afterAll` hooks. Mirrors
 * `useChaos` but targets the Service Worker. Returns an async teardown.
 */
export async function useSWChaos(
  page: ChaosPage,
  config: ChaosConfig,
  opts: SWChaosOptions = {},
): Promise<() => Promise<void>> {
  await injectSWChaos(page, config, opts);
  return () => removeSWChaos(page, opts);
}
