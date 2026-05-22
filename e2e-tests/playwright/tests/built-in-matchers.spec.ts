import { test, expect } from '@playwright/test';
import { injectChaos } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';

test.describe('Built-in matchers', () => {
  test('apiRequests built-in fires on API traffic', async ({ page }) => {
    await injectChaos(page, {
      seed: 1,
      network: {
        failures: [{ matcher: 'apiRequests', statusCode: 503, probability: 1 }],
      },
    });
    await page.goto(BASE_URL);

    const apiStatus = await page.evaluate(async () => {
      const r = await fetch('/api/data.json');
      return r.status;
    });
    expect(apiStatus).toBe(503);

    const otherStatus = await page.evaluate(async () => {
      const r = await fetch('/index.html');
      return r.status;
    });
    expect(otherStatus).toBe(200);
  });

  test('graphql built-in fires on GraphQL endpoint paths', async ({ page }) => {
    await injectChaos(page, {
      seed: 1,
      network: {
        failures: [{ matcher: 'graphql', statusCode: 503, probability: 1 }],
      },
    });
    await page.goto(BASE_URL);

    const gqlStatus = await page.evaluate(async () => {
      const r = await fetch('/graphql');
      return r.status;
    });
    expect(gqlStatus).toBe(503);

    const apiStatus = await page.evaluate(async () => {
      const r = await fetch('/api/data.json');
      return r.status;
    });
    expect(apiStatus).toBe(200);
  });

  test('authRequests built-in fires only on requests carrying an Authorization header', async ({ page }) => {
    await injectChaos(page, {
      seed: 1,
      network: {
        failures: [{ matcher: 'authRequests', statusCode: 503, probability: 1 }],
      },
    });
    await page.goto(BASE_URL);

    const authedStatus = await page.evaluate(async () => {
      const r = await fetch('/api/data.json', {
        headers: { Authorization: 'Bearer token' },
      });
      return r.status;
    });
    expect(authedStatus).toBe(503);

    const anonStatus = await page.evaluate(async () => {
      const r = await fetch('/api/data.json');
      return r.status;
    });
    expect(anonStatus).toBe(200);
  });

  test('a user matcher overrides the built-in of the same name', async ({ page }) => {
    await injectChaos(page, {
      seed: 1,
      matchers: { graphql: { urlPattern: '/api/data.json' } },
      network: {
        failures: [{ matcher: 'graphql', statusCode: 503, probability: 1 }],
      },
    });
    await page.goto(BASE_URL);

    const overrideTarget = await page.evaluate(async () => {
      const r = await fetch('/api/data.json');
      return r.status;
    });
    expect(overrideTarget).toBe(503);

    const builtInPath = await page.evaluate(async () => {
      const r = await fetch('/graphql');
      return r.status;
    });
    expect(builtInPath).not.toBe(503);
  });
});
