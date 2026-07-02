import { test, expect } from '@playwright/test';
import { injectChaos, getChaosLog } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';

test.describe('Preset: ai-slow-first-chunk', () => {
  test('declarative kebab name resolves and holds the first chat chunk', async ({ page }) => {
    await injectChaos(page, { presets: ['ai-slow-first-chunk'], seed: 1234 });
    await page.goto(BASE_URL);
    await page.click('#chat-start');

    await expect(page.locator('#chat-status')).toHaveText('done', { timeout: 10000 });
    await expect(page.locator('#chat-message-count')).toHaveText('5');

    // The fixture stamps first-chunk latency from BEFORE the fetch call, so
    // the 3000ms preset delay is fully covered by the measurement.
    const firstChunkMs = parseInt((await page.locator('#chat-first-chunk-ms').textContent()) ?? '0', 10);
    expect(firstChunkMs).toBeGreaterThan(2500);

    const log = await getChaosLog(page);
    expect(log.some((e) => e.type === 'fetch-stream:chunk-delayed' && e.applied)).toBe(true);
  });

  test('camelCase aiSlowFirstChunk resolves to the same preset', async ({ page }) => {
    await injectChaos(page, { presets: ['aiSlowFirstChunk'], seed: 1234 });
    await page.goto(BASE_URL);
    await page.click('#chat-start');

    await expect(page.locator('#chat-status')).toHaveText('done', { timeout: 10000 });
    const log = await getChaosLog(page);
    expect(log.some((e) => e.type === 'fetch-stream:chunk-delayed' && e.applied)).toBe(true);
  });
});
