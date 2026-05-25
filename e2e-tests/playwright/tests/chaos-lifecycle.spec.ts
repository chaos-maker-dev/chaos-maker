import { test, expect } from '@playwright/test';
import { injectChaos, removeChaos, getChaosLog } from '@chaos-maker/playwright';
import { presets } from '@chaos-maker/core';
import type { ChaosConfig } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';
const API_PATTERN = '/api/data.json';

// UI chaos must be started AFTER page load  -  the DOM assailant needs document.body.
async function injectUiChaos(page: import('@playwright/test').Page, config: ChaosConfig) {
  await page.evaluate((cfg) => {
    (window as any).chaosUtils.start(cfg);
  }, config);
}

// ---------------------------------------------------------------------------
// Chaos removal & restoration
// ---------------------------------------------------------------------------
test.describe('Chaos Lifecycle', () => {
  test('removeChaos restores normal fetch behavior', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 500, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);

    // With chaos  -  should fail
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Error!');

    // Remove chaos
    await removeChaos(page);

    // Without chaos  -  should succeed
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Success!');
  });

  test('chaos log captures events with correct structure', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Error!');

    const log = await getChaosLog(page);
    expect(log.length).toBeGreaterThan(0);

    for (const event of log) {
      expect(event).toHaveProperty('type');
      expect(event).toHaveProperty('timestamp');
      expect(event).toHaveProperty('applied');
      expect(event).toHaveProperty('detail');
      expect(typeof event.timestamp).toBe('number');
      expect(typeof event.applied).toBe('boolean');
    }
  });

  test('chaos log records URL and method in event detail', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 500, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Error!');

    const log = await getChaosLog(page);
    const failureEvent = log.find(e => e.type === 'network:failure' && e.applied);
    expect(failureEvent).toBeTruthy();
    expect(failureEvent!.detail.url).toContain(API_PATTERN);
    expect(failureEvent!.detail.method).toBe('GET');
    expect(failureEvent!.detail.statusCode).toBe(500);
  });

  test('combined network and UI chaos work simultaneously', async ({ page }) => {
    // Load UMD bundle only (empty config, no auto-start of actual chaos)
    await injectChaos(page, {});
    await page.goto(BASE_URL);

    // Start both network + UI chaos after page load (UI needs DOM to exist,
    // and chaosUtils.start() replaces any previous instance, so both must
    // be in a single call).
    await injectUiChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }],
      },
      ui: {
        assaults: [{ selector: '#submit-btn', action: 'disable', probability: 1.0 }],
      },
    });

    // Network chaos applied
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Error!');

    // UI chaos applied simultaneously
    await expect(page.locator('#submit-btn')).toBeDisabled();

    // Both event types in the log
    const log = await getChaosLog(page);
    expect(log.some(e => e.type === 'network:failure')).toBe(true);
    expect(log.some(e => e.type === 'ui:assault')).toBe(true);
  });
});

test.describe.parallel('Playwright page isolation', () => {
  test('failure chaos on one page does not affect another parallel page', async ({ browser }) => {
    const context = await browser.newContext();
    const chaosPage = await context.newPage();
    const cleanPage = await context.newPage();
    try {
      await injectChaos(chaosPage, {
        network: {
          failures: [{ urlPattern: API_PATTERN, statusCode: 502, probability: 1.0 }],
        },
      });
      await chaosPage.goto(BASE_URL);
      await cleanPage.goto(BASE_URL);

      await chaosPage.click('#fetch-data');
      await cleanPage.click('#fetch-data');

      await expect(chaosPage.locator('#status')).toHaveText('Error!');
      await expect(cleanPage.locator('#status')).toHaveText('Success!');
    } finally {
      await removeChaos(chaosPage).catch(() => undefined);
      await context.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
test.describe('Presets', () => {
  test('unstableApi preset targets /api/ paths', async ({ page }) => {
    await injectChaos(page, presets.unstableApi);
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    // With low probabilities (0.1/0.2), the request may or may not be affected.
    // We verify the chaos was injected and events were emitted.
    await page.waitForSelector('#status:not(:empty)');
    const log = await getChaosLog(page);
    // Events should be emitted for the /api/ match  -  applied or skipped
    expect(log.some(e => e.type === 'network:failure' || e.type === 'network:latency')).toBe(true);
  });

  test('slowNetwork preset adds latency to all requests', async ({ page }) => {
    await injectChaos(page, presets.slowNetwork);
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    // probability 1.0, delayMs 2000  -  request should take at least ~2s
    await expect(page.locator('#status')).toHaveText('Success!', { timeout: 10000 });
    const timing = await page.locator('#timing').textContent();
    const elapsed = parseInt(timing!);
    expect(elapsed).toBeGreaterThanOrEqual(1800);
  });

  test('offlineMode preset blocks all requests', async ({ page }) => {
    await injectChaos(page, presets.offlineMode);
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Error!');
    await expect(page.locator('#result')).toContainText('Failed to fetch');
  });

  test('flakyConnection preset injects chaos events', async ({ page }) => {
    await injectChaos(page, presets.flakyConnection);
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    // Low probabilities  -  just verify injection didn't crash
    await page.waitForSelector('#status:not(:empty)');
    const log = await getChaosLog(page);
    // Abort (0.05) and latency (0.1) events should be logged (applied or skipped)
    expect(log.some(e => e.type === 'network:abort' || e.type === 'network:latency')).toBe(true);
  });

  test('degradedUi preset assaults buttons and links', async ({ page }) => {
    // Load UMD bundle so chaosUtils is available after navigation
    await injectChaos(page, {});
    await page.goto(BASE_URL);
    // UI preset needs DOM  -  inject after load
    await injectUiChaos(page, presets.degradedUi);

    // Wait for MutationObserver to process
    await page.waitForTimeout(200);

    const log = await getChaosLog(page);
    const uiEvents = log.filter(e => e.type === 'ui:assault');
    // There are multiple buttons and links on the page  -  events should be emitted
    expect(uiEvents.length).toBeGreaterThan(0);
  });
});
