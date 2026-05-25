import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { injectChaos, getChaosLog } from '@chaos-maker/puppeteer';
import type { ChaosEvent } from '@chaos-maker/core';
import { launchBrowser, BASE_URL, WS_URL_PATTERN, waitForText } from './helpers';

let browser: Browser;
let page: Page;

beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser.close(); });

beforeEach(async () => { page = await browser.newPage(); });
afterEach(async () => { await page.close(); });

async function connect(p: Page): Promise<void> {
  await p.click('#ws-connect');
  await waitForText(p, '#ws-status', 'open');
}

async function sendMessages(p: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await p.click('#ws-send');
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function inboundCount(p: Page): Promise<number> {
  return p.$eval('#ws-inbound-count', (el) => Number(el.textContent));
}

describe('WebSocket drop', () => {
  it('drops every 2nd outbound message  -  server echoes half', async () => {
    await injectChaos(page, {
      websocket: {
        drops: [{ urlPattern: WS_URL_PATTERN, direction: 'outbound', probability: 1, everyNth: 2 }],
      },
    });
    await page.goto(BASE_URL);
    await connect(page);
    await sendMessages(page, 4);

    await page.waitForFunction(
      () => Number(document.getElementById('ws-inbound-count')?.textContent) === 2,
      { timeout: 5_000 },
    );
    expect(await inboundCount(page)).toBe(2);

    const log = await getChaosLog(page) as ChaosEvent[];
    const drops = log.filter((e) => e.type === 'websocket:drop' && e.detail.direction === 'outbound');
    expect(drops.length).toBe(2);
  });
});

describe('WebSocket delay', () => {
  it('delays inbound messages by >= 600ms relative to baseline', async () => {
    // Baseline
    await injectChaos(page, { websocket: {} });
    await page.goto(BASE_URL);
    await connect(page);
    const t0 = Date.now();
    await page.click('#ws-send');
    await page.waitForFunction(
      () => Number(document.getElementById('ws-inbound-count')?.textContent) === 1,
    );
    const baseline = Date.now() - t0;

    // With delay
    const page2 = await browser.newPage();
    await injectChaos(page2, {
      websocket: {
        delays: [{ urlPattern: WS_URL_PATTERN, direction: 'inbound', delayMs: 800, probability: 1 }],
      },
    });
    await page2.goto(BASE_URL);
    await page2.click('#ws-connect');
    await waitForText(page2, '#ws-status', 'open');
    const t1 = Date.now();
    await page2.click('#ws-send');
    await page2.waitForFunction(
      () => Number(document.getElementById('ws-inbound-count')?.textContent) === 1,
      { timeout: 10_000 },
    );
    const withChaos = Date.now() - t1;
    await page2.close();

    expect(withChaos - baseline).toBeGreaterThanOrEqual(600);
  });
});

describe('WebSocket corrupt', () => {
  it('truncates inbound text payload', async () => {
    await injectChaos(page, {
      websocket: {
        corruptions: [{ urlPattern: WS_URL_PATTERN, direction: 'inbound', strategy: 'truncate', probability: 1 }],
      },
    });
    await page.goto(BASE_URL);
    await connect(page);
    await page.click('#ws-send');
    await page.waitForFunction(
      () => Number(document.getElementById('ws-inbound-count')?.textContent) === 1,
      { timeout: 5_000 },
    );

    const logText = await page.$eval('#ws-log', (el) => el.textContent ?? '');
    // 'ping' truncated to half → 'pi'
    expect(logText).toMatch(/pi/);

    const log = await getChaosLog(page) as ChaosEvent[];
    const corrupted = log.find((e) => e.type === 'websocket:corrupt' && e.applied);
    expect(corrupted?.detail.strategy).toBe('truncate');
  });
});

describe('WebSocket close', () => {
  it('force-closes connection with configured code and reason', async () => {
    await injectChaos(page, {
      websocket: {
        closes: [{ urlPattern: WS_URL_PATTERN, probability: 1, afterMs: 500, code: 4000, reason: 'chaos' }],
      },
    });
    await page.goto(BASE_URL);
    await connect(page);

    await page.waitForFunction(
      () => document.getElementById('ws-status')?.textContent?.includes('closed'),
      { timeout: 5_000 },
    );
    const status = await page.$eval('#ws-status', (el) => el.textContent ?? '');
    expect(status).toContain('4000');

    const log = await getChaosLog(page) as ChaosEvent[];
    const closes = log.filter((e) => e.type === 'websocket:close' && e.applied);
    expect(closes.length).toBe(1);
    expect(closes[0].detail.closeCode).toBe(4000);
    expect(closes[0].detail.closeReason).toBe('chaos');
  });
});

describe('WebSocket direction filter', () => {
  it('onNth: 3 drops only the 3rd outbound message', async () => {
    await injectChaos(page, {
      websocket: {
        drops: [{ urlPattern: WS_URL_PATTERN, direction: 'outbound', probability: 1, onNth: 3 }],
      },
    });
    await page.goto(BASE_URL);
    await connect(page);
    await sendMessages(page, 5);

    await page.waitForFunction(
      () => Number(document.getElementById('ws-inbound-count')?.textContent) === 4,
      { timeout: 5_000 },
    );
    expect(await inboundCount(page)).toBe(4);

    const log = await getChaosLog(page) as ChaosEvent[];
    const drops = log.filter((e) => e.type === 'websocket:drop' && e.applied);
    expect(drops.length).toBe(1);
  });
});
