import { test, expect, type Page } from '@playwright/test';
import {
  injectSWChaos,
  removeSWChaos,
  getSWChaosLog,
  getSWChaosLogFromSW,
} from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080/sw-app/';

/**
 * WebKit's Playwright Service-Worker support is partial  -  `navigator.serviceWorker`
 * exists but SW-intercepted fetches behave differently enough that the chaos
 * harness can hang. Tests run on chromium/firefox/edge; keep webkit skipped
 * until Playwright fully supports it. Re-enable by removing the skip guard.
 */
const skipWebkit = ({ browserName }: { browserName: string }) => browserName === 'webkit';

async function registerClassicSW(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.evaluate(async () => {
    const fn = (globalThis as unknown as { __registerClassicSW?: () => Promise<unknown> })
      .__registerClassicSW;
    if (!fn) throw new Error('__registerClassicSW missing');
    await fn();
  });
  // Wait for controller to claim the page (SW skipWaiting + claim).
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, {
    timeout: 10_000,
  });
}

async function registerModuleSW(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.evaluate(async () => {
    const fn = (globalThis as unknown as { __registerModuleSW?: () => Promise<unknown> })
      .__registerModuleSW;
    if (!fn) throw new Error('__registerModuleSW missing');
    await fn();
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, {
    timeout: 10_000,
  });
}

async function unregisterAll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
  }).catch(() => { /* page may be closed */ });
}

test.describe('SW chaos  -  network failure', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(skipWebkit({ browserName }), 'webkit SW support is partial in Playwright');
    await registerClassicSW(page);
  });
  test.afterEach(async ({ page }) => {
    await removeSWChaos(page).catch(() => undefined);
    await unregisterAll(page);
  });

  test('injects 503 for SW-fetched /sw-api/* requests', async ({ page }) => {
    const { seed } = await injectSWChaos(page, {
      network: {
        failures: [{ urlPattern: '/api/data.json', statusCode: 503, probability: 1 }],
      },
      seed: 1,
    });
    expect(seed).toBe(1);

    await page.click('#sw-fetch');
    await expect(page.locator('#sw-fetch-status')).toHaveText('503', { timeout: 5_000 });

    const log = await getSWChaosLog(page);
    expect(log.some((e) => e.type === 'network:failure' && e.applied)).toBe(true);
  });

  test('SW log matches page-broadcast log', async ({ page }) => {
    await injectSWChaos(page, {
      network: {
        failures: [{ urlPattern: '/api/data.json', statusCode: 418, probability: 1 }],
      },
      seed: 2,
    });
    await page.click('#sw-fetch');
    await expect(page.locator('#sw-fetch-status')).toHaveText('418');
    // Poll until the local (broadcast) log has caught the 418 event  -  avoids
    // racing a fixed waitForTimeout against the final postMessage flush.
    await expect
      .poll(async () => (await getSWChaosLog(page)).some(
        (e) => e.type === 'network:failure' && e.applied && e.detail.statusCode === 418,
      ))
      .toBe(true);
    const local = await getSWChaosLog(page);
    const remote = await getSWChaosLogFromSW(page);
    const matchLocal = local.some(
      (e) => e.type === 'network:failure' && e.applied && e.detail.statusCode === 418,
    );
    const matchRemote = remote.some(
      (e) => e.type === 'network:failure' && e.applied && e.detail.statusCode === 418,
    );
    expect(matchLocal).toBe(true);
    expect(matchRemote).toBe(true);
  });
});

test.describe('SW chaos  -  latency', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(skipWebkit({ browserName }), 'webkit SW support is partial in Playwright');
    await registerClassicSW(page);
  });
  test.afterEach(async ({ page }) => {
    await removeSWChaos(page).catch(() => undefined);
    await unregisterAll(page);
  });

  test('adds delay to /sw-api/* fetches', async ({ page }) => {
    await injectSWChaos(page, {
      network: {
        latencies: [{ urlPattern: '/api/data.json', delayMs: 500, probability: 1 }],
      },
      seed: 3,
    });

    const start = Date.now();
    await page.click('#sw-fetch');
    await expect(page.locator('#sw-fetch-status')).toHaveText('200', { timeout: 5_000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(400);

    const log = await getSWChaosLog(page);
    expect(log.some((e) => e.type === 'network:latency' && e.applied)).toBe(true);
  });
});

test.describe('SW chaos  -  module SW', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(skipWebkit({ browserName }), 'webkit SW support is partial in Playwright');
    test.skip(
      browserName === 'firefox',
      'module service workers still behind a pref in most Firefox Playwright builds',
    );
    await registerModuleSW(page);
  });
  test.afterEach(async ({ page }) => {
    await removeSWChaos(page).catch(() => undefined);
    await unregisterAll(page);
  });

  test('module-SW variant patches fetch via installChaosSW()', async ({ page }) => {
    await injectSWChaos(page, {
      network: {
        failures: [{ urlPattern: '/api/data.json', statusCode: 500, probability: 1 }],
      },
      seed: 4,
    });
    await page.click('#sw-fetch');
    await expect(page.locator('#sw-fetch-status')).toHaveText('500');
  });
});

test.describe('SW chaos  -  stop restores fetch', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(skipWebkit({ browserName }), 'webkit SW support is partial in Playwright');
    await registerClassicSW(page);
  });
  test.afterEach(async ({ page }) => {
    await unregisterAll(page);
  });

  test('removeSWChaos stops injecting failures', async ({ page }) => {
    await injectSWChaos(page, {
      network: { failures: [{ urlPattern: '/api/data.json', statusCode: 503, probability: 1 }] },
      seed: 5,
    });
    await page.click('#sw-fetch');
    await expect(page.locator('#sw-fetch-status')).toHaveText('503');

    await removeSWChaos(page);
    // Clear prior fetch UI state.
    await page.evaluate(() => {
      document.getElementById('sw-fetch-status')!.textContent = '';
    });
    await page.click('#sw-fetch');
    await expect(page.locator('#sw-fetch-status')).toHaveText('200', { timeout: 5_000 });

    expect(await getSWChaosLog(page)).toEqual([]);
    expect(await getSWChaosLogFromSW(page)).toEqual([]);

    await injectSWChaos(page, {
      network: { failures: [{ urlPattern: '/api/data.json', statusCode: 418, probability: 1 }] },
      seed: 6,
    });
    await page.evaluate(() => {
      document.getElementById('sw-fetch-status')!.textContent = '';
    });
    await page.click('#sw-fetch');
    await expect(page.locator('#sw-fetch-status')).toHaveText('418', { timeout: 5_000 });
  });
});
