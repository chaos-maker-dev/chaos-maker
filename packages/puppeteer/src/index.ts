import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ChaosConfig, ChaosEvent, ValidateChaosConfigOptions } from '@chaos-maker/core';
import { serializeForTransport, validateChaosConfig } from '@chaos-maker/core';

/**
 * Minimal structural type for a Puppeteer `Page` object. Typed this way so we
 * don't force a hard dependency on puppeteer's internal types — any object
 * exposing these methods works (covers both `puppeteer` and `puppeteer-core`).
 */
export interface ChaosPage {
  evaluateOnNewDocument(
    pageFunction: string | ((...args: unknown[]) => void),
    ...args: unknown[]
  ): Promise<unknown>;
  removeScriptToEvaluateOnNewDocument?(identifier: string): Promise<void>;
  evaluate<T = unknown>(pageFunction: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
}

let cachedUmdSource: string | null = null;
let cachedUmdPath: string | null = null;

// Track init-script identifiers per page so removeChaos can tear them down.
// Without this, evaluateOnNewDocument scripts persist across navigations and
// re-inject chaos after removeChaos on subsequent page.goto() calls — breaks
// test frameworks that pool pages across cases.
const registeredInitScripts = new WeakMap<ChaosPage, string[]>();

function scriptIdentifier(handle: unknown): string | undefined {
  if (typeof handle === 'string') return handle;
  if (handle && typeof handle === 'object' && 'identifier' in handle) {
    const id = (handle as { identifier?: unknown }).identifier;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

function getCurrentDir(): string {
  return typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
}

function resolveCoreUmdPath(): string {
  if (cachedUmdPath) return cachedUmdPath;
  const req = createRequire(resolve(getCurrentDir(), 'package.json'));
  const coreEntry = req.resolve('@chaos-maker/core');
  const coreDistDir = dirname(coreEntry);
  cachedUmdPath = resolve(coreDistDir, 'chaos-maker.umd.js');
  return cachedUmdPath;
}

function loadCoreUmdSource(): string {
  if (cachedUmdSource !== null) return cachedUmdSource;
  cachedUmdSource = readFileSync(resolveCoreUmdPath(), 'utf8');
  return cachedUmdSource;
}

/** Options accepted by {@link injectChaos}. */
export interface InjectChaosOptions {
  /**
   * Forwarded to `validateChaosConfig` before the config is
   * serialized for the page. Malformed configs throw a `ChaosConfigError`
   * synchronously from Node before any page touch.
   */
  validation?: ValidateChaosConfigOptions;
}

/**
 * Inject chaos into a Puppeteer page. Call **before** `page.goto()` — uses
 * `evaluateOnNewDocument` to patch `fetch`, `XMLHttpRequest`, and `WebSocket`
 * before any page script runs.
 *
 * **UI chaos note:** The DOM assailant requires the DOM to exist when started.
 * For UI chaos, inject an empty config pre-nav to load the UMD bundle, navigate,
 * then call `page.evaluate((cfg) => window.chaosUtils.start(cfg), uiConfig)` after goto.
 *
 * @example
 * ```ts
 * import puppeteer from 'puppeteer';
 * import { injectChaos, getChaosLog } from '@chaos-maker/puppeteer';
 *
 * const browser = await puppeteer.launch();
 * const page = await browser.newPage();
 * await injectChaos(page, {
 *   network: { failures: [{ urlPattern: '/api', statusCode: 503, probability: 1.0 }] },
 * });
 * await page.goto('http://localhost:3000');
 * ```
 */
export async function injectChaos(
  page: ChaosPage,
  config: ChaosConfig,
  opts: InjectChaosOptions = {},
): Promise<void> {
  // Validate before any page side-effect so a malformed config throws
  // synchronously from Node, not from the browser console.
  const validated = validateChaosConfig(config, opts.validation);
  const umdSource = loadCoreUmdSource();

  // Remove any previously registered init scripts for this page so a repeat
  // injectChaos call replaces — rather than stacks on top of — the prior pair.
  const previousIds = registeredInitScripts.get(page) ?? [];
  const removeScript = page.removeScriptToEvaluateOnNewDocument?.bind(page);
  if (removeScript && previousIds.length > 0) {
    await Promise.all(previousIds.map((id) => removeScript(id).catch(() => undefined)));
  }

  // Set config in the page realm before the UMD loads so the auto-bootstrap
  // picks it up. Puppeteer JSON-encodes the argument, which would drop RegExp
  // matchers — pre-serialize to a transport-safe form. The in-page
  // chaosUtils.start auto-deserializes via deserializeForTransport.
  const serialized = serializeForTransport(validated);
  const configHandle = await page.evaluateOnNewDocument((cfg: unknown) => {
    (globalThis as unknown as Record<string, unknown>)['__CHAOS_CONFIG__'] = cfg;
  }, serialized as unknown);

  // Inject UMD source as a raw script string — fires before any navigation
  // script so all patching happens at document creation time.
  const umdHandle = await page.evaluateOnNewDocument(umdSource);

  const ids = [scriptIdentifier(configHandle), scriptIdentifier(umdHandle)]
    .filter((id): id is string => typeof id === 'string');
  if (ids.length > 0) {
    registeredInitScripts.set(page, ids);
  } else {
    registeredInitScripts.delete(page);
  }
}

/**
 * Stop chaos and restore original `fetch`, `XHR`, `WebSocket`, and DOM behavior.
 * Safe to call even if the page is already closed (rejects are swallowed).
 */
export async function removeChaos(page: ChaosPage): Promise<void> {
  // Remove tracked init scripts so subsequent page.goto() does not re-inject
  // chaos. No-op when the Puppeteer build does not expose the CDP helper
  // (kept optional on ChaosPage to preserve the structural contract).
  const scriptIds = registeredInitScripts.get(page) ?? [];
  registeredInitScripts.delete(page);
  const removeScript = page.removeScriptToEvaluateOnNewDocument?.bind(page);
  if (removeScript && scriptIds.length > 0) {
    await Promise.all(scriptIds.map((id) => removeScript(id).catch(() => undefined)));
  }

  await (page.evaluate(() => {
    const w = globalThis as unknown as { chaosUtils?: { stop: () => void } };
    if (w.chaosUtils && typeof w.chaosUtils.stop === 'function') {
      w.chaosUtils.stop();
    }
  }) as Promise<void>).catch(() => {
    // Page already closed during teardown — not a real error.
  });
}

/**
 * Read the chaos event log from the page. Returns every chaos decision emitted
 * since `injectChaos` was called, applied or skipped.
 */
export async function getChaosLog(page: ChaosPage): Promise<ChaosEvent[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { chaosUtils?: { getLog: () => unknown[] } };
    if (w.chaosUtils && typeof w.chaosUtils.getLog === 'function') {
      return w.chaosUtils.getLog() as ChaosEvent[];
    }
    return [] as ChaosEvent[];
  }) as Promise<ChaosEvent[]>;
}

/**
 * Enable a rule group at runtime in the page-side chaos engine.
 * Resolves once `page.evaluate` round-trips so the call is safe to await
 * before triggering an action that depends on the group being live.
 */
export async function enableGroup(page: ChaosPage, name: string): Promise<void> {
  if (typeof name !== 'string') {
    throw new Error('[chaos-maker] group name must be a string');
  }
  const nameNorm = name.trim();
  if (!nameNorm) {
    throw new Error('[chaos-maker] group name cannot be empty');
  }
  await page.evaluate((n: unknown) => {
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
    const result = utils.enableGroup(n as string);
    if (result && result.success === false) {
      throw new Error(`[chaos-maker] enableGroup('${n as string}') failed: ${result.message}`);
    }
  }, nameNorm as unknown);
}

/** Disable a rule group at runtime in the page-side chaos engine. */
export async function disableGroup(page: ChaosPage, name: string): Promise<void> {
  if (typeof name !== 'string') {
    throw new Error('[chaos-maker] group name must be a string');
  }
  const nameNorm = name.trim();
  if (!nameNorm) {
    throw new Error('[chaos-maker] group name cannot be empty');
  }
  await page.evaluate((n: unknown) => {
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
    const result = utils.disableGroup(n as string);
    if (result && result.success === false) {
      throw new Error(`[chaos-maker] disableGroup('${n as string}') failed: ${result.message}`);
    }
  }, nameNorm as unknown);
}

/**
 * Read the PRNG seed used by the active chaos instance. Log this on test
 * failure to replay the exact sequence of chaos decisions with the same seed.
 */
export async function getChaosSeed(page: ChaosPage): Promise<number | null> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { chaosUtils?: { getSeed: () => number | null } };
    if (w.chaosUtils && typeof w.chaosUtils.getSeed === 'function') {
      return w.chaosUtils.getSeed();
    }
    return null;
  }) as Promise<number | null>;
}

/**
 * Helper for test frameworks that use `afterEach`/`afterAll` hooks. Injects
 * chaos and returns an async teardown function — call the teardown in your
 * cleanup hook to restore normal browser behavior.
 *
 * @example
 * ```ts
 * let teardown: () => Promise<void>;
 * beforeEach(async () => {
 *   teardown = await useChaos(page, { network: { failures: [...] } });
 * });
 * afterEach(() => teardown());
 * ```
 */
export async function useChaos(
  page: ChaosPage,
  config: ChaosConfig,
  opts: InjectChaosOptions = {},
): Promise<() => Promise<void>> {
  await injectChaos(page, config, opts);
  return () => removeChaos(page);
}

export type {
  ChaosConfig,
  ChaosEvent,
  ChaosEventType,
  GraphQLOperationMatcher,
  NetworkConfig,
  NetworkFailureConfig,
  NetworkLatencyConfig,
  NetworkAbortConfig,
  NetworkCorruptionConfig,
  NetworkCorsConfig,
  NetworkRuleMatchers,
  CorruptionStrategy,
  UiConfig,
  UiAssaultConfig,
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

// Runtime export so adapter consumers can construct a Logger
// directly alongside the type re-exports above.
export { Logger } from '@chaos-maker/core';
// Validation surface re-exported for adapter consumers.
export { validateChaosConfig, ChaosConfigError, formatSeedReproduction } from '@chaos-maker/core';
export type {
  ValidateChaosConfigOptions,
  ValidationIssue,
  ValidationIssueCode,
  RuleType,
  CustomRuleValidator,
  CustomValidatorMap,
} from '@chaos-maker/core';

export {
  injectSWChaos,
  removeSWChaos,
  getSWChaosLog,
  getSWChaosLogFromSW,
  useSWChaos,
  enableSWGroup,
  disableSWGroup,
} from './sw';
export type { SWChaosOptions, InjectSWChaosResult } from './sw';
