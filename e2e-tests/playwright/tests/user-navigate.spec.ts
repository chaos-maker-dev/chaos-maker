import { test, expect } from '@playwright/test';
import { injectChaos } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';

// navigateAway lives outside the parity catalog: the navigation tears down the
// page context, so the shared log-collection contract cannot run. Covered here
// and in the Puppeteer suite; the trigger itself is unit-tested in core.
test.describe('User interaction: navigateAway', () => {
  test('location.assign fires after the configured delay', async ({ page }) => {
    await injectChaos(page, {
      seed: 42,
      userInteraction: { navigateAway: { afterMs: 1000, target: '/api/data.json' } },
    });
    await page.goto(BASE_URL);
    await page.waitForURL('**/api/data.json', { timeout: 10_000 });
    expect(page.url()).toContain('/api/data.json');
  });
});
