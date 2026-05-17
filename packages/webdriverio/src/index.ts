import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ChaosConfig, ChaosEvent, ValidateChaosConfigOptions } from '@chaos-maker/core';
import { serializeForTransport, validateChaosConfig, isSessionTeardownError } from '@chaos-maker/core';
import './types';

/** Options accepted by {@link injectChaos}. */
export interface InjectChaosOptions {
  /**
   * Forwarded to `validateChaosConfig` before the config is
   * serialized into the inline `<script>`. Malformed configs throw a
   * `ChaosConfigError` synchronously from Node before `browser.execute`
   * touches the page.
   */
  validation?: ValidateChaosConfigOptions;
}

/**
 * Minimal structural type for the WebdriverIO `Browser` object. Typed this way
 * so we don't have to take a hard type-only dependency on `webdriverio`'s
 * internal types — any object exposing `execute` works.
 */
export interface ChaosBrowser {
  execute<ReturnValue, Args extends unknown[]>(
    script: ((...args: Args) => ReturnValue) | string,
    ...args: Args
  ): Promise<ReturnValue>;
  addCommand?: (name: string, fn: (...args: unknown[]) => unknown) => void;
}

let cachedUmdSource: string | null = null;
let cachedUmdPath: string | null = null;

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

/**
 * Inject chaos into the current WebdriverIO browser page.
 *
 * Call **after** `browser.url(...)` — WebDriver has no generic pre-navigation
 * hook across Chromium/Firefox, so requests issued during the initial page
 * load are not intercepted. For full-lifecycle chaos use Playwright or Cypress.
 *
 * @example
 * ```ts
 * import { injectChaos, getChaosLog } from '@chaos-maker/webdriverio';
 *
 * it('handles API failure', async () => {
 *   await browser.url('/');
 *   await injectChaos(browser, {
 *     network: { failures: [{ urlPattern: '/api', statusCode: 503, probability: 1.0 }] },
 *   });
 *   await browser.$('button.refresh').click();
 *   const log = await getChaosLog(browser);
 *   expect(log.some(e => e.type === 'network:failure' && e.applied)).toBe(true);
 * });
 * ```
 */
export async function injectChaos(
  browser: ChaosBrowser,
  config: ChaosConfig,
  opts: InjectChaosOptions = {},
): Promise<void> {
  // Validate before any browser-side script touches the page so a malformed
  // config throws synchronously from Node, not from `browser.execute`.
  const validated = validateChaosConfig(config, opts.validation);
  const umdSource = loadCoreUmdSource();
  // Both the config assignment and UMD source run inside the <script> tag's
  // textContent so they execute in the page realm — Firefox/geckodriver runs
  // `executeScript` bodies in a sandbox whose globals don't leak to the real
  // `window`, so setting `window.__CHAOS_CONFIG__` from the execute callback
  // alone leaves the UMD's auto-bootstrap with nothing to pick up.
  // Pre-serialize so RegExp matchers (e.g. `graphqlOperation: /^Get/`) survive
  // the JSON.stringify into the inline <script> body. The in-page
  // chaosUtils.start auto-deserializes via deserializeForTransport.
  const serialized = serializeForTransport(validated);
  const scriptSource = `window.__CHAOS_CONFIG__ = ${JSON.stringify(serialized)};\n${umdSource}`;
  const started = await browser.execute((src: string) => {
    const script = document.createElement('script');
    script.textContent = src;
    (document.head || document.documentElement).appendChild(script);
    script.remove();

    const w = window as unknown as {
      chaosUtils?: { getSeed?: () => number | null };
    };
    return typeof w.chaosUtils?.getSeed === 'function' && w.chaosUtils.getSeed() !== null;
  }, scriptSource);

  if (!started) {
    throw new Error(
      '[chaos-maker] injectChaos did not start. Page may block inline scripts via CSP, or core auto-bootstrap failed.',
    );
  }
}

/**
 * Stop chaos and restore the original fetch / XHR / WebSocket / DOM behaviour
 * on the current page.
 */
export async function removeChaos(browser: ChaosBrowser): Promise<void> {
  // Read state off `window` (the page realm), not `globalThis` — in Firefox
  // geckodriver's executeScript sandbox `globalThis` is the sandbox global,
  // which never sees `chaosUtils` because the UMD attaches it to `window`.
  try {
    await browser.execute(() => {
      const w = window as unknown as { chaosUtils?: { stop: () => void } };
      if (w.chaosUtils && typeof w.chaosUtils.stop === 'function') {
        w.chaosUtils.stop();
      }
    });
  } catch (err) {
    if (!isSessionTeardownError(err)) throw err;
    // Session may already be torn down during framework cleanup.
  }
}

/**
 * Read the chaos event log from the current page. Returns every chaos decision
 * emitted since `injectChaos` was called, applied or skipped.
 */
export async function getChaosLog(browser: ChaosBrowser): Promise<ChaosEvent[]> {
  return browser.execute(() => {
    const w = window as unknown as { chaosUtils?: { getLog: () => unknown[] } };
    if (w.chaosUtils && typeof w.chaosUtils.getLog === 'function') {
      return w.chaosUtils.getLog() as ChaosEvent[];
    }
    return [] as ChaosEvent[];
  });
}

/**
 * Enable a rule group at runtime in the page-side chaos engine.
 * Resolves once `browser.execute` round-trips so the call is safe to await
 * before the next action that depends on the group being live.
 */
export async function enableGroup(browser: ChaosBrowser, name: string): Promise<void> {
  if (typeof name !== 'string') {
    throw new Error('[chaos-maker] group name must be a string');
  }
  const nameNorm = name.trim();
  if (!nameNorm) {
    throw new Error('[chaos-maker] group name cannot be empty');
  }
  await browser.execute((n: string) => {
    const w = window as unknown as {
      chaosUtils?: {
        instance: unknown;
        enableGroup?: (n: string) => { success: boolean; message: string };
      };
    };
    if (!w.chaosUtils || !w.chaosUtils.instance) {
      throw new Error('[chaos-maker] no chaos instance on page — call injectChaos first');
    }
    if (typeof w.chaosUtils.enableGroup !== 'function') {
      throw new Error('[chaos-maker] enableGroup API unavailable');
    }
    const result = w.chaosUtils.enableGroup(n);
    if (result && result.success === false) {
      throw new Error(`[chaos-maker] enableGroup('${n}') failed: ${result.message}`);
    }
  }, nameNorm);
}

/** Disable a rule group at runtime in the page-side chaos engine. */
export async function disableGroup(browser: ChaosBrowser, name: string): Promise<void> {
  if (typeof name !== 'string') {
    throw new Error('[chaos-maker] group name must be a string');
  }
  const nameNorm = name.trim();
  if (!nameNorm) {
    throw new Error('[chaos-maker] group name cannot be empty');
  }
  await browser.execute((n: string) => {
    const w = window as unknown as {
      chaosUtils?: {
        instance: unknown;
        disableGroup?: (n: string) => { success: boolean; message: string };
      };
    };
    if (!w.chaosUtils || !w.chaosUtils.instance) {
      throw new Error('[chaos-maker] no chaos instance on page — call injectChaos first');
    }
    if (typeof w.chaosUtils.disableGroup !== 'function') {
      throw new Error('[chaos-maker] disableGroup API unavailable');
    }
    const result = w.chaosUtils.disableGroup(n);
    if (result && result.success === false) {
      throw new Error(`[chaos-maker] disableGroup('${n}') failed: ${result.message}`);
    }
  }, nameNorm);
}

/**
 * Read the PRNG seed used by the active chaos instance. Log this on test
 * failure to replay the exact sequence of chaos decisions with a fixed seed.
 */
export async function getChaosSeed(browser: ChaosBrowser): Promise<number | null> {
  return browser.execute(() => {
    const w = window as unknown as {
      chaosUtils?: { getSeed: () => number | null };
    };
    if (w.chaosUtils && typeof w.chaosUtils.getSeed === 'function') {
      return w.chaosUtils.getSeed();
    }
    return null;
  });
}

/**
 * Register chaos-maker's custom WDIO commands on a browser object. After
 * calling this once (typically in `before` hook of `wdio.conf.ts`), tests can
 * call `browser.injectChaos(config)`, `browser.removeChaos()`,
 * `browser.getChaosLog()`, `browser.getChaosSeed()`,
 * `browser.enableGroup(name)`, and `browser.disableGroup(name)` directly.
 */
export function registerChaosCommands(browser: ChaosBrowser): void {
  if (!browser.addCommand) {
    throw new Error(
      '[chaos-maker] registerChaosCommands: browser object does not expose addCommand — not a WebdriverIO Browser?',
    );
  }
  browser.addCommand('injectChaos', async function (this: ChaosBrowser, ...args: unknown[]) {
    await injectChaos(this, args[0] as ChaosConfig, args[1] as InjectChaosOptions | undefined);
  });
  browser.addCommand('removeChaos', async function (this: ChaosBrowser) {
    await removeChaos(this);
  });
  browser.addCommand('getChaosLog', async function (this: ChaosBrowser) {
    return getChaosLog(this);
  });
  browser.addCommand('getChaosSeed', async function (this: ChaosBrowser) {
    return getChaosSeed(this);
  });
  browser.addCommand('enableGroup', async function (this: ChaosBrowser, ...args: unknown[]) {
    await enableGroup(this, args[0] as string);
  });
  browser.addCommand('disableGroup', async function (this: ChaosBrowser, ...args: unknown[]) {
    await disableGroup(this, args[0] as string);
  });
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
  registerSWChaosCommands,
  enableSWGroup,
  disableSWGroup,
} from './sw';
export type { SWChaosOptions, InjectSWChaosResult } from './sw';
