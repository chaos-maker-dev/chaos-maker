import type { Page, TestInfo } from '@playwright/test';
import type { ChaosConfig, ChaosEvent, ValidateChaosConfigOptions } from '@chaos-maker/core';
import { serializeForTransport, validateChaosConfig } from '@chaos-maker/core';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
  createTraceReporter,
  TraceReporterHandle,
  TraceReporterOptions,
} from './trace';

let cachedUmdPath: string | null = null;

function getCoreUmdPath(): string {
  if (cachedUmdPath) return cachedUmdPath;

  // Support both ESM and CJS module resolution
  const currentDir = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  const req = createRequire(resolve(currentDir, 'package.json'));
  // Resolve the main entry point to find the dist directory — avoids
  // requiring `./package.json` which isn't in the exports map.
  const coreEntry = req.resolve('@chaos-maker/core');
  const coreDistDir = dirname(coreEntry);
  cachedUmdPath = resolve(coreDistDir, 'chaos-maker.umd.js');
  return cachedUmdPath;
}

/**
 * Options for `injectChaos`. Most callers can omit this entirely; defaults
 * preserve backward compatibility with the v0.1.x signature.
 */
export interface InjectChaosOptions {
  /**
   * Emit chaos events into the Playwright trace as `test.step` entries and
   * attach the full event log on test end.
   *
   * - `true` — always on. Requires `testInfo`.
   * - `false` (default for direct `injectChaos()` calls) — off.
   * - `'auto'` (default for the fixture) — on when Playwright tracing is
   *   enabled in the project config; no-op otherwise.
   */
  tracing?: boolean | 'auto';
  /**
   * Active Playwright `TestInfo`, required when `tracing` is truthy.
   * The fixture supplies this automatically.
   */
  testInfo?: TestInfo;
  /** Pass through to the trace reporter. */
  traceOptions?: TraceReporterOptions;
  /**
   * Forwarded to `validateChaosConfig` before the config is
   * serialized for the page. Use to relax unknown-field handling, hook
   * deprecation events, or run custom per-`RuleType` validators. Malformed
   * configs throw a `ChaosConfigError` synchronously from Node.
   */
  validation?: ValidateChaosConfigOptions;
}

/** Symbol used to stash the tracing handle on the Page object for cleanup. */
const TRACE_HANDLE_KEY = Symbol.for('chaos-maker.playwright.traceHandle');

/**
 * Inject chaos into a Playwright page. Call before `page.goto()` to ensure
 * all network requests are intercepted from the start.
 *
 * @example
 * ```ts
 * import { injectChaos } from '@chaos-maker/playwright';
 *
 * test('handles API failure', async ({ page }) => {
 *   await injectChaos(page, {
 *     network: {
 *       failures: [{ urlPattern: '/api', statusCode: 503, probability: 1.0 }]
 *     }
 *   });
 *   await page.goto('/');
 * });
 * ```
 */
export async function injectChaos(
  page: Page,
  config: ChaosConfig,
  opts: InjectChaosOptions = {},
): Promise<void> {
  // Validate from Node BEFORE touching the page so a malformed config throws
  // synchronously from the test runner instead of asynchronously from the
  // browser console.
  const validated = validateChaosConfig(config, opts.validation);

  const umdPath = getCoreUmdPath();

  // Resolve tracing decision before touching the page.
  const tracingEnabled = resolveTracing(opts);

  // Wire the trace bridge BEFORE the UMD loads so the in-page subscriber can
  // attach as soon as chaosUtils.instance exists.
  if (tracingEnabled) {
    if (!opts.testInfo) {
      throw new Error(
        '[chaos-maker] tracing requires a `testInfo` in InjectChaosOptions. ' +
        'Use the fixture (`@chaos-maker/playwright/fixture`) or pass testInfo explicitly.',
      );
    }
    // Avoid double-binding on re-inject.
    const existing = (page as any)[TRACE_HANDLE_KEY] as TraceReporterHandle | undefined;
    if (!existing) {
      const handle = await createTraceReporter(page, opts.testInfo, opts.traceOptions);
      (page as any)[TRACE_HANDLE_KEY] = handle;
    }
  }

  // addInitScript JSON-encodes its argument, which would drop RegExp matchers
  // (e.g. `graphqlOperation: /^Get/`). Serialize to a transport-safe form here;
  // the in-page chaosUtils.start auto-deserializes via deserializeForTransport.
  const serialized = serializeForTransport(validated);
  await page.addInitScript((cfg: unknown) => {
    const win = globalThis as any;
    win.__CHAOS_CONFIG__ = cfg;
  }, serialized);

  // Load core UMD bundle by path — no eval needed
  await page.addInitScript({ path: umdPath });
}

function resolveTracing(opts: InjectChaosOptions): boolean {
  if (opts.tracing === true) return true;
  if (opts.tracing === false || opts.tracing === undefined) return false;
  // 'auto' — fixture must have pre-resolved this to true/false before calling
  // injectChaos. If it reaches here as 'auto', treat as off (no testInfo
  // context available to introspect project.use.trace).
  return false;
}

/**
 * Remove chaos from a Playwright page. Restores original fetch/XHR/DOM behavior.
 */
export async function removeChaos(page: Page): Promise<void> {
  // Read seed BEFORE stop() clears the instance.
  const handle = (page as any)[TRACE_HANDLE_KEY] as TraceReporterHandle | undefined;
  let seed: number | null = null;
  if (handle) {
    try {
      seed = await getChaosSeed(page);
    } catch {
      // Page closed / detached — fall through with seed=null.
    }
  }

  await page.evaluate(() => {
    const win = globalThis as any;
    if (win.chaosUtils) {
      win.chaosUtils.stop();
    }
  }).catch(() => {
    // Page may already be closed during teardown — don't mask real failures.
  });

  // Flush trace attachment if tracing was active.
  if (handle) {
    await handle.dispose(seed);
    delete (page as any)[TRACE_HANDLE_KEY];
  }
}

/**
 * Retrieve the chaos event log from a Playwright page.
 * Returns all events emitted since chaos was injected.
 */
export async function getChaosLog(page: Page): Promise<ChaosEvent[]> {
  return page.evaluate(() => {
    const win = globalThis as any;
    if (win.chaosUtils) {
      return win.chaosUtils.getLog();
    }
    return [];
  });
}

/**
 * Enable a rule group at runtime in the page-side chaos engine. Resolves once
 * `page.evaluate` round-trips so the call is safe to await before triggering
 * the assertion that depends on the group being live.
 */
export async function enableGroup(page: Page, name: string): Promise<void> {
  if (typeof name !== 'string') {
    throw new Error('[chaos-maker] group name must be a string');
  }
  const nameNorm = name.trim();
  if (!nameNorm) {
    throw new Error('[chaos-maker] group name cannot be empty');
  }
  await page.evaluate(({ n }: { n: string }) => {
    const utils = (globalThis as unknown as {
      chaosUtils?: {
        instance: unknown;
        enableGroup?: (n: string) => { success: boolean; message: string };
      };
    }).chaosUtils;
    if (!utils || !utils.instance) {
      throw new Error('[chaos-maker] no chaos instance on page — call injectChaos first');
    }
    if (typeof utils.enableGroup !== 'function') {
      throw new Error('[chaos-maker] enableGroup API unavailable');
    }
    const result = utils.enableGroup(n);
    if (result && result.success === false) {
      throw new Error(`[chaos-maker] enableGroup('${n}') failed: ${result.message}`);
    }
  }, { n: nameNorm });
}

/** Disable a rule group at runtime in the page-side chaos engine. */
export async function disableGroup(page: Page, name: string): Promise<void> {
  if (typeof name !== 'string') {
    throw new Error('[chaos-maker] group name must be a string');
  }
  const nameNorm = name.trim();
  if (!nameNorm) {
    throw new Error('[chaos-maker] group name cannot be empty');
  }
  await page.evaluate(({ n }: { n: string }) => {
    const utils = (globalThis as unknown as {
      chaosUtils?: {
        instance: unknown;
        disableGroup?: (n: string) => { success: boolean; message: string };
      };
    }).chaosUtils;
    if (!utils || !utils.instance) {
      throw new Error('[chaos-maker] no chaos instance on page — call injectChaos first');
    }
    if (typeof utils.disableGroup !== 'function') {
      throw new Error('[chaos-maker] disableGroup API unavailable');
    }
    const result = utils.disableGroup(n);
    if (result && result.success === false) {
      throw new Error(`[chaos-maker] disableGroup('${n}') failed: ${result.message}`);
    }
  }, { n: nameNorm });
}

/**
 * Retrieve the PRNG seed from a Playwright page.
 * Log this value on test failure to replay exact chaos decisions.
 */
export async function getChaosSeed(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const win = globalThis as any;
    if (win.chaosUtils) {
      return win.chaosUtils.getSeed();
    }
    return null;
  });
}

export type {
  ChaosConfig,
  ChaosEvent,
  ValidateChaosConfigOptions,
  ValidationIssue,
  ValidationIssueCode,
  RuleType,
  CustomRuleValidator,
  CustomValidatorMap,
  GraphQLOperationMatcher,
  NetworkConfig,
  NetworkFailureConfig,
  NetworkLatencyConfig,
  NetworkAbortConfig,
  NetworkCorruptionConfig,
  NetworkCorsConfig,
  NetworkRuleMatchers,
  CorruptionStrategy,
  WebSocketConfig,
  WebSocketDropConfig,
  WebSocketDelayConfig,
  WebSocketCorruptConfig,
  WebSocketCloseConfig,
  WebSocketDirection,
  WebSocketCorruptionStrategy,
  SSEConfig,
  SSEDropConfig,
  SSEDelayConfig,
  SSECorruptConfig,
  SSECloseConfig,
  SSECorruptionStrategy,
  SSEEventTypeMatcher,
  ChaosDebugStage,
  ChaosLifecyclePhase,
  DebugOptions,
  Profile,
  ProfileConfigSlice,
  ProfileOverrideSlice,
} from '@chaos-maker/core';

export type { TraceReporterOptions, ChaosTraceAttachment } from './trace';
// Runtime export so adapter consumers can construct a Logger
// directly alongside the type re-exports above.
export { Logger } from '@chaos-maker/core';
// Re-export the structured validation surface so adapter consumers
// can validate on demand outside of injectChaos and import the error type.
export { validateChaosConfig, ChaosConfigError, formatSeedReproduction } from '@chaos-maker/core';

export {
  injectSWChaos,
  removeSWChaos,
  getSWChaosLog,
  getSWChaosLogFromSW,
  enableSWGroup,
  disableSWGroup,
} from './sw';
export type { SWChaosOptions, InjectSWChaosResult } from './sw';
