import { test, expect } from '@playwright/test';
import { injectChaos, getChaosLog, getChaosSeed } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';
const API_PATTERN = '/api/data.json';
const SEED = 42;

// ---------------------------------------------------------------------------
// Seeded Randomness
// ---------------------------------------------------------------------------
test.describe('Seeded Randomness', () => {
  test('same seed produces identical chaos outcomes across runs', async ({ page }) => {
    // Run 1: inject chaos with seed, make several requests, collect log
    await injectChaos(page, {
      seed: SEED,
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 0.5 }],
      },
    });
    await page.goto(BASE_URL);

    // Make multiple requests to exercise the PRNG
    for (let i = 0; i < 5; i++) {
      await page.click('#fetch-data');
      await page.locator('#status').filter({ hasNotText: 'Loading...' }).waitFor();
    }

    const log1 = await getChaosLog(page);
    const outcomes1 = log1
      .filter(e => e.type === 'network:failure')
      .map(e => e.applied);

    // Run 2: fresh page, same seed, same config
    const page2 = await page.context().newPage();
    await injectChaos(page2, {
      seed: SEED,
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 0.5 }],
      },
    });
    await page2.goto(BASE_URL);

    for (let i = 0; i < 5; i++) {
      await page2.click('#fetch-data');
      await page2.locator('#status').filter({ hasNotText: 'Loading...' }).waitFor();
    }

    const log2 = await getChaosLog(page2);
    const outcomes2 = log2
      .filter(e => e.type === 'network:failure')
      .map(e => e.applied);

    await page2.close();

    // Both runs should produce identical sequences
    expect(outcomes1).toEqual(outcomes2);
    expect(outcomes1.length).toBe(5);
  });

  test('different seeds produce different chaos outcomes', async ({ page }) => {
    await injectChaos(page, {
      seed: 42,
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 0.5 }],
      },
    });
    await page.goto(BASE_URL);

    for (let i = 0; i < 10; i++) {
      await page.click('#fetch-data');
      await page.locator('#status').filter({ hasNotText: 'Loading...' }).waitFor();
    }

    const log1 = await getChaosLog(page);
    const outcomes1 = log1
      .filter(e => e.type === 'network:failure')
      .map(e => e.applied);

    // Fresh page with different seed
    const page2 = await page.context().newPage();
    await injectChaos(page2, {
      seed: 99,
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 0.5 }],
      },
    });
    await page2.goto(BASE_URL);

    for (let i = 0; i < 10; i++) {
      await page2.click('#fetch-data');
      await page2.locator('#status').filter({ hasNotText: 'Loading...' }).waitFor();
    }

    const log2 = await getChaosLog(page2);
    const outcomes2 = log2
      .filter(e => e.type === 'network:failure')
      .map(e => e.applied);

    await page2.close();

    // With 10 trials at p=0.5, different seeds should produce different sequences
    // (extremely unlikely to match by chance: 1/1024)
    expect(outcomes1).not.toEqual(outcomes2);
  });

  test('getSeed returns the seed used by the instance', async ({ page }) => {
    await injectChaos(page, {
      seed: 12345,
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);

    const seed = await getChaosSeed(page);
    expect(seed).toBe(12345);
  });

  test('auto-generated seed is retrievable when no seed is provided', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);

    const seed = await getChaosSeed(page);
    expect(typeof seed).toBe('number');
    expect(Number.isInteger(seed)).toBe(true);
  });

  test('seed works with probability 1.0  -  always applies', async ({ page }) => {
    await injectChaos(page, {
      seed: SEED,
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Error!');
    await expect(page.locator('#result')).toContainText('503');
  });

  test('seed works with probability 0  -  never applies', async ({ page }) => {
    await injectChaos(page, {
      seed: SEED,
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Success!');
  });
});
