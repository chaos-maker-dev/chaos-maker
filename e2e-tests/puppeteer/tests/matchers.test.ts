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

describe('Advanced matchers', () => {
  it('hostname matcher fires for matching host', async () => {
    await injectChaos(page, {
      seed: 1,
      network: {
        failures: [
          {
            urlPattern: '*',
            hostname: '127.0.0.1',
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    });
    await page.goto(BASE_URL);
    const status = await page.evaluate(async () => {
      const r = await fetch('/api/data.json');
      return r.status;
    });
    expect(status).toBe(503);
  });

  it('named matcher inlines into a referencing rule', async () => {
    await injectChaos(page, {
      seed: 1,
      matchers: {
        customers: { urlPattern: '/api/data.json', queryParams: { type: 'customer' } },
      },
      network: {
        failures: [
          { matcher: 'customers', statusCode: 503, probability: 1 },
        ],
      },
    });
    await page.goto(BASE_URL);
    const matched = await page.evaluate(async () => {
      const r = await fetch('/api/data.json?type=customer');
      return r.status;
    });
    expect(matched).toBe(503);
    const missed = await page.evaluate(async () => {
      const r = await fetch('/api/data.json?type=product');
      return r.status;
    });
    expect(missed).toBe(200);
  });
});
