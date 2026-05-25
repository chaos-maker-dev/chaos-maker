import { test, expect, type Page } from '@playwright/test';
import { injectChaos, getChaosLog, getChaosSeed } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';
const SSE_URL_PATTERN = '127.0.0.1:8082';

async function connectDefault(page: Page): Promise<void> {
  await page.click('#sse-connect');
  await expect(page.locator('#sse-status')).toHaveText('open');
}

async function messageCount(page: Page): Promise<number> {
  return Number(await page.locator('#sse-message-count').textContent());
}

// ---------------------------------------------------------------------------
// Drop  -  every 2nd inbound message is silently discarded.
// ---------------------------------------------------------------------------
test.describe('SSE drop', () => {
  test('drops every 2nd inbound event and emits sse:drop', async ({ page }) => {
    await injectChaos(page, {
      sse: {
        drops: [{ urlPattern: SSE_URL_PATTERN, probability: 1, everyNth: 2 }],
      },
    });
    await page.goto(BASE_URL);
    await connectDefault(page);
    // Wait for several ticks (server fires every 200ms).
    await page.waitForTimeout(1500);
    const count = await messageCount(page);
    // With everyNth: 2 the app sees roughly half of the emitted ticks.
    expect(count).toBeGreaterThan(0);

    const log = await getChaosLog(page);
    const drops = log.filter(e => e.type === 'sse:drop' && e.applied);
    expect(drops.length).toBeGreaterThan(0);
    // everyNth: 2 → drop / deliver should be roughly balanced. Loose bound
    // tolerates ±1 jitter when a tick happens to land on a window boundary.
    expect(Math.abs(drops.length - count)).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Delay  -  every event is held for delayMs before delivery.
// ---------------------------------------------------------------------------
test.describe('SSE delay', () => {
  test('delays inbound by >= 600ms relative to baseline', async ({ page }) => {
    await injectChaos(page, { sse: {} });
    await page.goto(BASE_URL);
    await connectDefault(page);
    const t0 = Date.now();
    await page.waitForFunction(() => Number(document.getElementById('sse-message-count')?.textContent) >= 1);
    const baseline = Date.now() - t0;

    const page2 = await page.context().newPage();
    await injectChaos(page2, {
      sse: { delays: [{ urlPattern: SSE_URL_PATTERN, delayMs: 800, probability: 1 }] },
    });
    await page2.goto(BASE_URL);
    await page2.click('#sse-connect');
    await expect(page2.locator('#sse-status')).toHaveText('open');
    const t1 = Date.now();
    await page2.waitForFunction(() => Number(document.getElementById('sse-message-count')?.textContent) >= 1, null, { timeout: 5000 });
    const withChaos = Date.now() - t1;

    expect(withChaos - baseline).toBeGreaterThanOrEqual(600);

    const log = await getChaosLog(page2);
    expect(log.filter(e => e.type === 'sse:delay').length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Corrupt  -  truncate strategy halves event.data text.
// ---------------------------------------------------------------------------
test.describe('SSE corrupt', () => {
  test('truncates inbound text payload', async ({ page }) => {
    await injectChaos(page, {
      sse: { corruptions: [{ urlPattern: SSE_URL_PATTERN, strategy: 'truncate', probability: 1 }] },
    });
    await page.goto(BASE_URL);
    await connectDefault(page);
    await page.waitForFunction(() => Number(document.getElementById('sse-message-count')?.textContent) >= 1);

    const logText = await page.locator('#sse-log').textContent();
    // Server emits 'tick N'; truncated to half = 'tic' (length 3) for 'tick 1'.
    expect(logText).toMatch(/msg \d+ tic/);

    const log = await getChaosLog(page);
    const corrupted = log.find(e => e.type === 'sse:corrupt' && e.applied);
    expect(corrupted?.detail.strategy).toBe('truncate');
  });
});

// ---------------------------------------------------------------------------
// Close  -  force-close the EventSource after afterMs.
// ---------------------------------------------------------------------------
test.describe('SSE close', () => {
  test('force-closes the source after afterMs', async ({ page }) => {
    await injectChaos(page, {
      sse: { closes: [{ urlPattern: SSE_URL_PATTERN, probability: 1, afterMs: 600 }] },
    });
    await page.goto(BASE_URL);
    await connectDefault(page);

    await expect(page.locator('#sse-status')).toContainText('error', { timeout: 3000 });

    const log = await getChaosLog(page);
    const closes = log.filter(e => e.type === 'sse:close' && e.applied);
    expect(closes.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Named event  -  eventType filter targets only the named event.
// ---------------------------------------------------------------------------
test.describe('SSE named eventType', () => {
  test('drops only named "tick" events; default messages survive', async ({ page }) => {
    await injectChaos(page, {
      sse: { drops: [{ urlPattern: '/sse-named', eventType: 'tick', probability: 1 }] },
    });
    await page.goto(BASE_URL);
    await page.click('#sse-connect-named');
    await expect(page.locator('#sse-status')).toHaveText('open');
    await page.waitForTimeout(1500);

    const tickCount = Number(await page.locator('#sse-tick-count').textContent());
    const msgCount = Number(await page.locator('#sse-message-count').textContent());
    expect(tickCount).toBe(0);
    expect(msgCount).toBeGreaterThan(0);

    const log = await getChaosLog(page);
    const drops = log.filter(e => e.type === 'sse:drop' && e.applied);
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.every(e => e.detail.eventType === 'tick')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Seeded replay  -  identical seeds → identical drop sequence.
//
// Server emits `tick N` with sequential N. App records delivered ticks in
// `#sse-log` (`msg <ts> tick N`). The dropped tick numbers = {1..max} minus
// the delivered set. Same seed + same probability + same engine-event order
// must produce identical dropped-tick sets.
// ---------------------------------------------------------------------------
test.describe('SSE seeded replay', () => {
  async function deliveredTickNumbers(page: Page): Promise<number[]> {
    const text = await page.locator('#sse-log').textContent() ?? '';
    return [...text.matchAll(/tick (\d+)/g)].map(m => Number(m[1]));
  }

  async function waitForTotalEvents(page: Page, target: number): Promise<void> {
    await page.waitForFunction(([t]) => {
      const win = globalThis as unknown as { chaosUtils?: { getLog: () => { type: string; applied: boolean }[] } };
      const drops = win.chaosUtils
        ? win.chaosUtils.getLog().filter(e => e.type === 'sse:drop' && e.applied).length
        : 0;
      const delivered = Number(document.getElementById('sse-message-count')?.textContent ?? 0);
      return drops + delivered >= t;
    }, [target], { timeout: 10_000 });
  }

  test('same seed produces identical dropped-tick sets', async ({ page }) => {
    const cfg = {
      seed: 9000,
      sse: { drops: [{ urlPattern: SSE_URL_PATTERN, probability: 0.5 }] },
    };
    const TARGET = 6;

    await injectChaos(page, cfg);
    await page.goto(BASE_URL);
    await connectDefault(page);
    await waitForTotalEvents(page, TARGET);
    const seed1 = await getChaosSeed(page);
    const delivered1 = await deliveredTickNumbers(page);
    const drops1 = (await getChaosLog(page)).filter(e => e.type === 'sse:drop' && e.applied).length;
    const max1 = Math.max(drops1 + delivered1.length, ...delivered1);
    const dropped1 = new Set<number>();
    for (let i = 1; i <= max1; i++) if (!delivered1.includes(i)) dropped1.add(i);

    const page2 = await page.context().newPage();
    await injectChaos(page2, cfg);
    await page2.goto(BASE_URL);
    await page2.click('#sse-connect');
    await expect(page2.locator('#sse-status')).toHaveText('open');
    await waitForTotalEvents(page2, TARGET);
    const seed2 = await getChaosSeed(page2);
    const delivered2 = await deliveredTickNumbers(page2);
    const drops2 = (await getChaosLog(page2)).filter(e => e.type === 'sse:drop' && e.applied).length;
    const max2 = Math.max(drops2 + delivered2.length, ...delivered2);
    const dropped2 = new Set<number>();
    for (let i = 1; i <= max2; i++) if (!delivered2.includes(i)) dropped2.add(i);

    expect(seed1).toBe(9000);
    expect(seed2).toBe(9000);
    // Two runs may stop after a different total tick count, so compare the
    // shared prefix only  -  every tick index present in both windows must
    // have the same drop/deliver outcome.
    const sharedMax = Math.min(max1, max2);
    const prefix1 = [...dropped1].filter(n => n <= sharedMax).sort((a, b) => a - b);
    const prefix2 = [...dropped2].filter(n => n <= sharedMax).sort((a, b) => a - b);
    expect(prefix1).toEqual(prefix2);
    // Sanity: at least one drop in the shared window so the assertion isn't
    // trivially satisfied by an empty set.
    expect(prefix1.length).toBeGreaterThan(0);
  });
});
