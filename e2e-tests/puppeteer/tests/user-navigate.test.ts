import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { injectChaos } from '@chaos-maker/puppeteer';
import { launchBrowser, BASE_URL } from './helpers';

let browser: Browser;
let page: Page;

beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser.close(); });

beforeEach(async () => { page = await browser.newPage(); });
afterEach(async () => { await page.close(); });

// navigateAway lives outside the parity catalog: the navigation tears down the
// page context, so the shared log-collection contract cannot run. Covered here
// and in the Playwright suite; the trigger itself is unit-tested in core.
describe('User interaction: navigateAway', () => {
  it('location.assign fires after the configured delay', async () => {
    await injectChaos(page, {
      seed: 42,
      userInteraction: { navigateAway: { afterMs: 1000, target: '/api/data.json' } },
    });
    await page.goto(BASE_URL);
    // Poll the final URL rather than waitForNavigation: the event-based wait can
    // attach after the redirect fires and miss it, making the test flaky.
    await page.waitForFunction(
      () => location.href.includes('/api/data.json'),
      { timeout: 10_000 },
    );
    expect(page.url()).toContain('/api/data.json');
  });
});
