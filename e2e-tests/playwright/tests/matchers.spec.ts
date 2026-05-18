import { test, expect } from '@playwright/test';
import { injectChaos, getChaosLog } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';

test.describe('Advanced matchers', () => {
  test('hostname matcher only fires for the targeted host', async ({ page }) => {
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

    const log = await getChaosLog(page);
    expect(
      log.some((e) => e.type === 'network:failure' && e.applied),
    ).toBe(true);
  });

  test('queryParams matcher fires only when every entry passes', async ({ page }) => {
    await injectChaos(page, {
      seed: 1,
      network: {
        failures: [
          {
            urlPattern: '/api/data.json',
            queryParams: { role: 'admin' },
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    });
    await page.goto(BASE_URL);

    const matchStatus = await page.evaluate(async () => {
      const r = await fetch('/api/data.json?role=admin');
      return r.status;
    });
    expect(matchStatus).toBe(503);

    const missStatus = await page.evaluate(async () => {
      const r = await fetch('/api/data.json?role=user');
      return r.status;
    });
    expect(missStatus).toBe(200);
  });

  test('requestHeaders matcher checks request headers case-insensitively', async ({ page }) => {
    await injectChaos(page, {
      seed: 1,
      network: {
        failures: [
          {
            urlPattern: '/api/data.json',
            requestHeaders: { 'x-tenant': 'acme' },
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    });
    await page.goto(BASE_URL);

    const matchStatus = await page.evaluate(async () => {
      const r = await fetch('/api/data.json', { headers: { 'X-Tenant': 'acme' } });
      return r.status;
    });
    expect(matchStatus).toBe(503);

    const missStatus = await page.evaluate(async () => {
      const r = await fetch('/api/data.json');
      return r.status;
    });
    expect(missStatus).toBe(200);
  });

  test('resourceTypes restricts a rule to a single interceptor', async ({ page }) => {
    await injectChaos(page, {
      seed: 1,
      network: {
        failures: [
          {
            urlPattern: '/api/data.json',
            resourceTypes: ['fetch'],
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    });
    await page.goto(BASE_URL);

    const fetchStatus = await page.evaluate(async () => {
      const r = await fetch('/api/data.json');
      return r.status;
    });
    expect(fetchStatus).toBe(503);

    const xhrStatus = await page.evaluate(async () => {
      return new Promise<number>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/data.json');
        xhr.onloadend = () => resolve(xhr.status);
        xhr.send();
      });
    });
    expect(xhrStatus).toBe(200);
  });

  test('named matcher inlines registered fields into every referencing rule', async ({ page }) => {
    await injectChaos(page, {
      seed: 1,
      matchers: {
        customers: { urlPattern: '/api/data.json', queryParams: { type: 'customer' } },
      },
      network: {
        failures: [
          { matcher: 'customers', statusCode: 503, probability: 1 },
        ],
        latencies: [
          { matcher: 'customers', delayMs: 50, probability: 1 },
        ],
      },
    });
    await page.goto(BASE_URL);

    const status = await page.evaluate(async () => {
      const r = await fetch('/api/data.json?type=customer');
      return r.status;
    });
    expect(status).toBe(503);

    const otherStatus = await page.evaluate(async () => {
      const r = await fetch('/api/data.json?type=product');
      return r.status;
    });
    expect(otherStatus).toBe(200);

    const log = await getChaosLog(page);
    const failureMatched = log.find(
      (e) => e.type === 'network:failure' && e.applied,
    );
    expect(failureMatched).toBeDefined();
  });
});
