import { test, expect } from '@playwright/test';
import { injectChaos, getChaosLog, getChaosSeed } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';

test.describe('profileOverrides at inject site', () => {
  test('runtime override appends an abort rule on top of the resolved profile', async ({ page }) => {
    await injectChaos(page, {
      profile: 'mobile-checkout',
      profileOverrides: {
        network: {
          aborts: [{ urlPattern: '/api/data', probability: 1 }],
        },
      },
      seed: 4321,
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    // The status text becomes 'Error' (or the fetch otherwise fails) because
    // the override-appended abort rule fires on the next /api/data request.
    await expect(page.locator('#status')).not.toHaveText('Success!', { timeout: 10000 });

    const log = await getChaosLog(page);
    expect(log.some((e) => e.type === 'network:abort' && e.applied)).toBe(true);
  });

  test('overrides scalar seed wins over top-level seed', async ({ page }) => {
    await injectChaos(page, {
      profile: 'mobile-checkout',
      seed: 111,
      profileOverrides: { seed: 999 },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Success!', { timeout: 10000 });

    // Resolved seed is the override scalar (999), proving profileOverrides.seed
    // wins over the top-level seed (111). The latency event additionally
    // confirms the override-scalar layered through validation without rejection.
    expect(await getChaosSeed(page)).toBe(999);
    const log = await getChaosLog(page);
    expect(log.some((e) => e.type === 'network:latency' && e.applied)).toBe(true);
  });
});
