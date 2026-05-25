import { test, expect, type Page } from '@playwright/test';
import { injectChaos, getChaosLog, getChaosSeed } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';
const WS_URL_PATTERN = '127.0.0.1:8081';

async function connect(page: Page): Promise<void> {
  await page.click('#ws-connect');
  await expect(page.locator('#ws-status')).toHaveText('open');
}

async function send(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.click('#ws-send');
    // Small settle so the send events are serialized; chaos timing may hold
    // ordering otherwise.
    await page.waitForTimeout(30);
  }
}

async function inboundCount(page: Page): Promise<number> {
  return Number(await page.locator('#ws-inbound-count').textContent());
}

// ---------------------------------------------------------------------------
// Drop  -  outbound every other message
// ---------------------------------------------------------------------------
test.describe('WebSocket drop', () => {
  test('drops every 2nd outbound message; server echoes only half', async ({ page }) => {
    await injectChaos(page, {
      websocket: {
        drops: [{ urlPattern: WS_URL_PATTERN, direction: 'outbound', probability: 1, everyNth: 2 }],
      },
    });
    await page.goto(BASE_URL);
    await connect(page);
    await send(page, 4);
    // Give the server time to echo the non-dropped messages back.
    await page.waitForFunction(() => Number(document.getElementById('ws-inbound-count')?.textContent) === 2, null, { timeout: 5000 });
    expect(await inboundCount(page)).toBe(2);

    const log = await getChaosLog(page);
    const drops = log.filter(e => e.type === 'websocket:drop' && e.detail.direction === 'outbound');
    expect(drops.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Delay  -  inbound messages arrive no sooner than delayMs
// ---------------------------------------------------------------------------
test.describe('WebSocket delay', () => {
  test('delays inbound by >= 800ms (relative to baseline)', async ({ page }) => {
    // Baseline: no chaos, measure round-trip.
    await injectChaos(page, { websocket: {} });
    await page.goto(BASE_URL);
    await connect(page);
    const t0 = Date.now();
    await send(page, 1);
    await page.waitForFunction(() => Number(document.getElementById('ws-inbound-count')?.textContent) === 1);
    const baseline = Date.now() - t0;

    // Chaos run with 800ms inbound delay.
    const page2 = await page.context().newPage();
    await injectChaos(page2, {
      websocket: {
        delays: [{ urlPattern: WS_URL_PATTERN, direction: 'inbound', delayMs: 800, probability: 1 }],
      },
    });
    await page2.goto(BASE_URL);
    await page2.click('#ws-connect');
    await expect(page2.locator('#ws-status')).toHaveText('open');
    const t1 = Date.now();
    await page2.click('#ws-send');
    await page2.waitForFunction(() => Number(document.getElementById('ws-inbound-count')?.textContent) === 1);
    const withChaos = Date.now() - t1;

    // Relative assertion dominates over baseline jitter on slow browser projects.
    expect(withChaos - baseline).toBeGreaterThanOrEqual(600);

    const log = await getChaosLog(page2);
    expect(log.filter(e => e.type === 'websocket:delay').length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Corrupt  -  truncate inbound payload
// ---------------------------------------------------------------------------
test.describe('WebSocket corrupt', () => {
  test('truncates inbound text payload', async ({ page }) => {
    await injectChaos(page, {
      websocket: {
        corruptions: [{ urlPattern: WS_URL_PATTERN, direction: 'inbound', strategy: 'truncate', probability: 1 }],
      },
    });
    await page.goto(BASE_URL);
    await connect(page);
    await send(page, 1);
    await page.waitForFunction(() => Number(document.getElementById('ws-inbound-count')?.textContent) === 1);

    const logText = await page.locator('#ws-log').textContent();
    // 'ping' truncated to half → 'pi' (length 2).
    expect(logText).toMatch(/in \d+ pi\n/);

    const log = await getChaosLog(page);
    const corrupted = log.find(e => e.type === 'websocket:corrupt' && e.applied);
    expect(corrupted?.detail.strategy).toBe('truncate');
  });
});

// ---------------------------------------------------------------------------
// Close  -  force-close after 500ms with custom code/reason
// ---------------------------------------------------------------------------
test.describe('WebSocket close', () => {
  test('force-closes after afterMs with configured code and reason', async ({ page }) => {
    await injectChaos(page, {
      websocket: {
        closes: [{ urlPattern: WS_URL_PATTERN, probability: 1, afterMs: 500, code: 4000, reason: 'chaos' }],
      },
    });
    await page.goto(BASE_URL);
    await connect(page);

    await expect(page.locator('#ws-status')).toContainText('closed', { timeout: 3000 });
    await expect(page.locator('#ws-status')).toContainText('4000');

    const log = await getChaosLog(page);
    const closes = log.filter(e => e.type === 'websocket:close' && e.applied);
    expect(closes.length).toBe(1);
    expect(closes[0].detail.closeCode).toBe(4000);
    expect(closes[0].detail.closeReason).toBe('chaos');
  });
});

// ---------------------------------------------------------------------------
// Seeded replay  -  identical seeds → identical drop patterns
// ---------------------------------------------------------------------------
test.describe('WebSocket seeded replay', () => {
  test('same seed produces identical drop outcomes', async ({ page }) => {
    const cfg = {
      seed: 777,
      websocket: {
        drops: [{ urlPattern: WS_URL_PATTERN, direction: 'outbound' as const, probability: 0.5 }],
      },
    };
    await injectChaos(page, cfg);
    await page.goto(BASE_URL);
    await connect(page);
    await send(page, 6);
    await page.waitForTimeout(500);
    const seed1 = await getChaosSeed(page);
    const drops1 = (await getChaosLog(page))
      .filter(e => e.type === 'websocket:drop')
      .map(e => e.detail.direction);

    const page2 = await page.context().newPage();
    await injectChaos(page2, cfg);
    await page2.goto(BASE_URL);
    await page2.click('#ws-connect');
    await expect(page2.locator('#ws-status')).toHaveText('open');
    for (let i = 0; i < 6; i++) {
      await page2.click('#ws-send');
      await page2.waitForTimeout(30);
    }
    await page2.waitForTimeout(500);
    const seed2 = await getChaosSeed(page2);
    const drops2 = (await getChaosLog(page2))
      .filter(e => e.type === 'websocket:drop')
      .map(e => e.detail.direction);

    expect(seed1).toBe(777);
    expect(seed2).toBe(777);
    expect(drops1).toEqual(drops2);
  });
});

// ---------------------------------------------------------------------------
// Counting  -  onNth: 3 drops only the 3rd outbound
// ---------------------------------------------------------------------------
test.describe('WebSocket counting', () => {
  test('onNth: 3 drops only the 3rd outbound message', async ({ page }) => {
    await injectChaos(page, {
      websocket: {
        drops: [{ urlPattern: WS_URL_PATTERN, direction: 'outbound', probability: 1, onNth: 3 }],
      },
    });
    await page.goto(BASE_URL);
    await connect(page);
    await send(page, 5);
    await page.waitForFunction(() => Number(document.getElementById('ws-inbound-count')?.textContent) === 4, null, { timeout: 5000 });
    expect(await inboundCount(page)).toBe(4);

    const log = await getChaosLog(page);
    const drops = log.filter(e => e.type === 'websocket:drop' && e.applied && e.detail.direction === 'outbound');
    expect(drops.length).toBe(1);
  });
});
