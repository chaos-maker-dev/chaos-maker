import { test, expect, type Page } from '@playwright/test';
import { injectChaos, getChaosLog } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';

async function inboundCount(page: Page): Promise<number> {
  return Number(await page.locator('#ws-inbound-count').textContent());
}

async function sseMessageCount(page: Page): Promise<number> {
  return Number(await page.locator('#sse-message-count').textContent());
}

test.describe('Cross-transport matchers', () => {
  test('WS named matcher fires when hostname matches registered entry', async ({ page }) => {
    await injectChaos(page, {
      seed: 42,
      matchers: { realtime: { hostname: '127.0.0.1' } },
      websocket: {
        drops: [
          { matcher: 'realtime', direction: 'outbound', probability: 1 } as never,
        ],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#ws-connect');
    await expect(page.locator('#ws-status')).toHaveText('open');
    await page.click('#ws-send');
    // Echo would push inbound count to 1 if chaos did not drop the outbound.
    await page.waitForTimeout(500);
    expect(await inboundCount(page)).toBe(0);

    const log = await getChaosLog(page);
    const drops = log.filter((e) => e.type === 'websocket:drop' && e.applied);
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  test('WS inline queryParams fires for ?room=alpha and skips for ?room=beta', async ({ page }) => {
    await injectChaos(page, {
      seed: 42,
      websocket: {
        drops: [
          {
            urlPattern: '127.0.0.1:8081',
            direction: 'outbound',
            queryParams: { room: 'alpha' },
            probability: 1,
          } as never,
        ],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#ws-connect-alpha');
    await expect(page.locator('#ws-status')).toHaveText('open');
    await page.click('#ws-send');
    await page.waitForTimeout(500);
    expect(await inboundCount(page)).toBe(0);

    const page2 = await page.context().newPage();
    await injectChaos(page2, {
      seed: 42,
      websocket: {
        drops: [
          {
            urlPattern: '127.0.0.1:8081',
            direction: 'outbound',
            queryParams: { room: 'alpha' },
            probability: 1,
          } as never,
        ],
      },
    });
    await page2.goto(BASE_URL);
    await page2.click('#ws-connect-beta');
    await expect(page2.locator('#ws-status')).toHaveText('open');
    await page2.click('#ws-send');
    await page2.waitForFunction(
      () => Number(document.getElementById('ws-inbound-count')?.textContent) === 1,
      null,
      { timeout: 3000 },
    );
    expect(await inboundCount(page2)).toBe(1);
  });

  test('SSE named matcher fires on registered hostname', async ({ page }) => {
    await injectChaos(page, {
      seed: 42,
      matchers: { feed: { hostname: '127.0.0.1' } },
      sse: {
        drops: [{ matcher: 'feed', probability: 1 } as never],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#sse-connect-alerts');
    await expect(page.locator('#sse-status')).toHaveText('open');
    // SSE server emits a frame every 200ms. Wait long enough for several.
    await page.waitForTimeout(1000);
    expect(await sseMessageCount(page)).toBe(0);

    const log = await getChaosLog(page);
    const drops = log.filter((e) => e.type === 'sse:drop' && e.applied);
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  test('SSE inline queryParams fires for ?topic=alerts and skips for ?topic=quotes', async ({ page }) => {
    await injectChaos(page, {
      seed: 42,
      sse: {
        drops: [
          {
            urlPattern: '/sse-topics',
            queryParams: { topic: 'alerts' },
            probability: 1,
          } as never,
        ],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#sse-connect-alerts');
    await expect(page.locator('#sse-status')).toHaveText('open');
    await page.waitForTimeout(1000);
    expect(await sseMessageCount(page)).toBe(0);

    const page2 = await page.context().newPage();
    await injectChaos(page2, {
      seed: 42,
      sse: {
        drops: [
          {
            urlPattern: '/sse-topics',
            queryParams: { topic: 'alerts' },
            probability: 1,
          } as never,
        ],
      },
    });
    await page2.goto(BASE_URL);
    await page2.click('#sse-connect-quotes');
    await expect(page2.locator('#sse-status')).toHaveText('open');
    await page2.waitForFunction(
      () => Number(document.getElementById('sse-message-count')?.textContent) >= 1,
      null,
      { timeout: 3000 },
    );
    expect(await sseMessageCount(page2)).toBeGreaterThanOrEqual(1);
  });

  test('debug event surfaces matchedBy on WS drop', async ({ page }) => {
    await injectChaos(page, {
      seed: 42,
      debug: true,
      websocket: {
        drops: [
          {
            urlPattern: '127.0.0.1:8081',
            direction: 'outbound',
            hostname: '127.0.0.1',
            probability: 1,
          } as never,
        ],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#ws-connect');
    await expect(page.locator('#ws-status')).toHaveText('open');
    await page.click('#ws-send');
    await page.waitForTimeout(300);

    const log = await getChaosLog(page);
    const matched = log.find(
      (e) =>
        e.type === 'debug' &&
        e.detail.stage === 'rule-matched' &&
        Array.isArray(e.detail.matchedBy) &&
        (e.detail.matchedBy as string[]).includes('hostname'),
    );
    expect(matched).toBeDefined();
  });
});
