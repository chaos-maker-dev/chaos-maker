import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { injectChaos, getChaosLog } from '@chaos-maker/puppeteer';
import type { ChaosEvent } from '@chaos-maker/core';
import { launchBrowser, BASE_URL, waitForText } from './helpers';

let browser: Browser;
let page: Page;

beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser.close(); });

beforeEach(async () => { page = await browser.newPage(); });
afterEach(async () => { await page.close(); });

async function inboundCount(p: Page): Promise<number> {
  return p.$eval('#ws-inbound-count', (el) => Number(el.textContent));
}

async function sseMessageCount(p: Page): Promise<number> {
  return p.$eval('#sse-message-count', (el) => Number(el.textContent));
}

describe('Cross-transport matchers', () => {
  it('WS named matcher fires when hostname matches registered entry', async () => {
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
    await waitForText(page, '#ws-status', 'open');
    await page.click('#ws-send');
    await new Promise((r) => setTimeout(r, 500));
    expect(await inboundCount(page)).toBe(0);

    const log = (await getChaosLog(page)) as ChaosEvent[];
    const drops = log.filter((e) => e.type === 'websocket:drop' && e.applied);
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  it('WS inline queryParams fires for ?room=alpha and skips for ?room=beta', async () => {
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
    await waitForText(page, '#ws-status', 'open');
    await page.click('#ws-send');
    await new Promise((r) => setTimeout(r, 500));
    expect(await inboundCount(page)).toBe(0);

    const page2 = await browser.newPage();
    try {
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
      await waitForText(page2, '#ws-status', 'open');
      await page2.click('#ws-send');
      await page2.waitForFunction(
        () => Number(document.getElementById('ws-inbound-count')?.textContent) === 1,
        { timeout: 3000 },
      );
      expect(await inboundCount(page2)).toBe(1);
    } finally {
      await page2.close();
    }
  });

  it('SSE named matcher fires on registered hostname', async () => {
    await injectChaos(page, {
      seed: 42,
      matchers: { feed: { hostname: '127.0.0.1' } },
      sse: {
        drops: [{ matcher: 'feed', probability: 1 } as never],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#sse-connect-alerts');
    await waitForText(page, '#sse-status', 'open');
    await new Promise((r) => setTimeout(r, 1000));
    expect(await sseMessageCount(page)).toBe(0);

    const log = (await getChaosLog(page)) as ChaosEvent[];
    const drops = log.filter((e) => e.type === 'sse:drop' && e.applied);
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  it('SSE inline queryParams fires for ?topic=alerts and skips for ?topic=quotes', async () => {
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
    await waitForText(page, '#sse-status', 'open');
    await new Promise((r) => setTimeout(r, 1000));
    expect(await sseMessageCount(page)).toBe(0);

    const page2 = await browser.newPage();
    try {
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
      await waitForText(page2, '#sse-status', 'open');
      await page2.waitForFunction(
        () => Number(document.getElementById('sse-message-count')?.textContent) >= 1,
        { timeout: 3000 },
      );
      expect(await sseMessageCount(page2)).toBeGreaterThanOrEqual(1);
    } finally {
      await page2.close();
    }
  });

  it('debug event surfaces matchedBy on WS drop', async () => {
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
    await waitForText(page, '#ws-status', 'open');
    await page.click('#ws-send');
    await new Promise((r) => setTimeout(r, 300));

    const log = (await getChaosLog(page)) as ChaosEvent[];
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
