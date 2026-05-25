import { test as base } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import type { ChaosConfig, ChaosEvent } from '@chaos-maker/core';
import {
  injectChaos,
  removeChaos,
  getChaosLog,
  getChaosSeed,
  enableGroup,
  disableGroup,
  enableSWGroup,
  disableSWGroup,
  InjectChaosOptions,
} from './index';
import type { SWChaosOptions } from './sw';

export interface ChaosFixture {
  inject: (config: ChaosConfig, opts?: InjectChaosOptions) => Promise<void>;
  remove: () => Promise<void>;
  getLog: () => Promise<ChaosEvent[]>;
  getSeed: () => Promise<number | null>;
  enableGroup: (name: string) => Promise<void>;
  disableGroup: (name: string) => Promise<void>;
  enableSWGroup: (name: string, opts?: SWChaosOptions) => Promise<void>;
  disableSWGroup: (name: string, opts?: SWChaosOptions) => Promise<void>;
}

/**
 * Resolve the auto-tracing decision: on when Playwright's own tracing is
 * enabled for this project, off otherwise. Users override per-call with
 * `chaos.inject(config, { tracing: false })`.
 */
function shouldAutoTrace(testInfo: TestInfo): boolean {
  // `project.use.trace` may be a string ('on' | 'off' | 'retain-on-failure' | …)
  // or an object with a `mode` field. Treat anything other than 'off' as on.
  // Unrecognized shapes (stray boolean/number from user misconfig) fall
  // through to `false`  -  conservative default; don't silently opt in to a
  // feature based on a value we can't interpret.
  const trace = (testInfo.project.use as { trace?: unknown } | undefined)?.trace;
  if (trace == null) return false;
  if (typeof trace === 'string') return trace !== 'off';
  if (typeof trace === 'object' && trace !== null && 'mode' in trace) {
    return (trace as { mode?: string }).mode !== 'off';
  }
  return false;
}

/**
 * Extended Playwright test with a `chaos` fixture.
 *
 * Tracing is auto-enabled when the project's `use.trace` config is not `'off'`.
 * Override with `chaos.inject(config, { tracing: false })` to opt out.
 *
 * @example
 * ```ts
 * import { test, expect } from '@chaos-maker/playwright/fixture';
 *
 * test('handles API failure', async ({ page, chaos }) => {
 *   await chaos.inject({
 *     network: {
 *       failures: [{ urlPattern: '/api', statusCode: 503, probability: 1.0 }]
 *     }
 *   });
 *   await page.goto('/');
 *   const log = await chaos.getLog();
 *   expect(log.some(e => e.type === 'network:failure' && e.applied)).toBe(true);
 * });
 * ```
 */
export const test = base.extend<{ chaos: ChaosFixture }>({
  chaos: async (
    { page }: { page: Page },
    use: (fixture: ChaosFixture) => Promise<void>,
    testInfo: TestInfo,
  ) => {
    const autoTrace = shouldAutoTrace(testInfo);

    const fixture: ChaosFixture = {
      inject: (config: ChaosConfig, opts: InjectChaosOptions = {}) => {
        // Resolve 'auto' here where testInfo is available.
        let tracing = opts.tracing;
        if (tracing === undefined || tracing === 'auto') {
          tracing = autoTrace;
        }
        return injectChaos(page, config, {
          ...opts,
          tracing,
          testInfo: opts.testInfo ?? testInfo,
        });
      },
      remove: () => removeChaos(page),
      getLog: () => getChaosLog(page),
      getSeed: () => getChaosSeed(page),
      enableGroup: (name: string) => enableGroup(page, name),
      disableGroup: (name: string) => disableGroup(page, name),
      enableSWGroup: (name: string, opts?: SWChaosOptions) => enableSWGroup(page, name, opts),
      disableSWGroup: (name: string, opts?: SWChaosOptions) => disableSWGroup(page, name, opts),
    };
    await use(fixture);
    await removeChaos(page);
  },
});

export { expect } from '@playwright/test';
export type { ChaosConfig, ChaosEvent } from '@chaos-maker/core';
export type { InjectChaosOptions } from './index';
