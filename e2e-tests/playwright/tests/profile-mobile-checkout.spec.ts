import { test, expect } from '@playwright/test';
import { injectChaos, getChaosLog } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';

test.describe('Profile: mobileCheckout', () => {
  test('built-in profile composes mobile-3g latency on the request path', async ({ page }) => {
    await injectChaos(page, { profile: 'mobile-checkout', seed: 1234 });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Success!', { timeout: 10000 });
    const elapsed = parseInt((await page.locator('#timing').textContent()) ?? '0', 10);
    expect(elapsed).toBeGreaterThan(1000);

    const log = await getChaosLog(page);
    expect(log.some((e) => e.type === 'network:latency' && e.applied)).toBe(true);
  });

  test('camelCase mobileCheckout resolves to the same profile', async ({ page }) => {
    await injectChaos(page, { profile: 'mobileCheckout', seed: 1234 });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Success!', { timeout: 10000 });
    const log = await getChaosLog(page);
    expect(log.some((e) => e.type === 'network:latency')).toBe(true);
  });
});
