import { test, expect } from '@playwright/test';
import { injectChaos, getChaosLog } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';

test.describe('Named matcher attribution across the page boundary', () => {
  test('debug events carry matcherName for a rule resolved from a named matcher', async ({ page }) => {
    await injectChaos(page, {
      seed: 7,
      debug: true,
      matchers: {
        dataApi: { urlPattern: '/api/data' },
      },
      network: {
        failures: [{ matcher: 'dataApi', statusCode: 503, probability: 1 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Error!', { timeout: 10000 });

    const log = await getChaosLog(page);
    // The matcher resolves node-side; the name must still be attributed by
    // the in-page engine after the config crossed the JSON boundary.
    const attributed = log.filter(
      (e) => e.type === 'debug' && e.detail.matcherName === 'dataApi',
    );
    expect(attributed.length).toBeGreaterThan(0);
    expect(
      attributed.some((e) => e.detail.stage === 'rule-applied'),
    ).toBe(true);
  });

  test('fetch-stream rules resolved from a named matcher fire and attribute', async ({ page }) => {
    await injectChaos(page, {
      seed: 7,
      debug: true,
      matchers: {
        chat: { urlPattern: '/chat' },
      },
      fetchStream: {
        corruptions: [{ matcher: 'chat', strategy: 'empty', probability: 1 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#chat-start');
    await expect(page.locator('#chat-status')).toHaveText('done', { timeout: 10000 });

    const log = await getChaosLog(page);
    const corrupted = log.filter((e) => e.type === 'fetch-stream:chunk-corrupted' && e.applied);
    expect(corrupted.length).toBeGreaterThan(0);
    const attributed = log.filter(
      (e) => e.type === 'debug' && e.detail.matcherName === 'chat' && e.detail.ruleType === 'fetch-stream-corrupt',
    );
    expect(attributed.length).toBeGreaterThan(0);
  });
});
