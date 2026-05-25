import { test, expect, type Page } from '@playwright/test';
import { injectChaos, getChaosLog } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';
const API_PATTERN = '/api/data.json';

/** Click a button and wait for the status element to settle (leaves Loading... state). */
async function makeRequest(page: Page, buttonId = '#fetch-data', statusId = '#status') {
  await page.click(buttonId);
  await page.locator(statusId).filter({ hasNotText: 'Loading...' }).waitFor();
  return page.locator(statusId).textContent();
}

// ---------------------------------------------------------------------------
// onNth  -  failure fires only on the Nth request
// ---------------------------------------------------------------------------
test.describe('onNth counting', () => {
  test('fetch: fails only on the 3rd request', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, onNth: 3 }],
      },
    });
    await page.goto(BASE_URL);

    const r1 = await makeRequest(page);
    const r2 = await makeRequest(page);
    const r3 = await makeRequest(page);
    const r4 = await makeRequest(page);

    expect(r1).toBe('Success!');
    expect(r2).toBe('Success!');
    expect(r3).toBe('Error!');
    expect(r4).toBe('Success!');

    const log = await getChaosLog(page);
    const failures = log.filter(e => e.type === 'network:failure');
    expect(failures.length).toBe(1);
    expect(failures[0].applied).toBe(true);
  });

  test('fetch: fails only on the 1st request when onNth is 1', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 500, probability: 1.0, onNth: 1 }],
      },
    });
    await page.goto(BASE_URL);

    const r1 = await makeRequest(page);
    const r2 = await makeRequest(page);
    const r3 = await makeRequest(page);

    expect(r1).toBe('Error!');
    expect(r2).toBe('Success!');
    expect(r3).toBe('Success!');
  });

  test('XHR: fails only on the 2nd request', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, onNth: 2 }],
      },
    });
    await page.goto(BASE_URL);

    // Use XHR button; its status element is #xhr-status
    const r1 = await makeRequest(page, '#xhr-get', '#xhr-status');
    const r2 = await makeRequest(page, '#xhr-get', '#xhr-status');
    const r3 = await makeRequest(page, '#xhr-get', '#xhr-status');

    expect(r1).toBe('Success!');
    expect(r2).toBe('Error!');
    expect(r3).toBe('Success!');
  });
});

// ---------------------------------------------------------------------------
// everyNth  -  failure fires on every Nth request
// ---------------------------------------------------------------------------
test.describe('everyNth counting', () => {
  test('fetch: fails on every 2nd request', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, everyNth: 2 }],
      },
    });
    await page.goto(BASE_URL);

    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(await makeRequest(page) as string);
    }

    // Requests 2, 4, 6 should fail; 1, 3, 5 should succeed
    expect(results[0]).toBe('Success!');
    expect(results[1]).toBe('Error!');
    expect(results[2]).toBe('Success!');
    expect(results[3]).toBe('Error!');
    expect(results[4]).toBe('Success!');
    expect(results[5]).toBe('Error!');
  });

  test('fetch: fails on every 3rd request', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, everyNth: 3 }],
      },
    });
    await page.goto(BASE_URL);

    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(await makeRequest(page) as string);
    }

    expect(results[0]).toBe('Success!'); // 1
    expect(results[1]).toBe('Success!'); // 2
    expect(results[2]).toBe('Error!');   // 3
    expect(results[3]).toBe('Success!'); // 4
    expect(results[4]).toBe('Success!'); // 5
    expect(results[5]).toBe('Error!');   // 6
  });

  test('fetch: latency applied on every 2nd request', async ({ page }) => {
    // Use a large delay so the injected latency dominates CI cold-start /
    // scheduler jitter (uninjected requests can cost 100–300ms on first hit
    // in firefox/webkit). 800ms vs a ~400ms threshold leaves headroom for
    // slow Firefox CI runners where undelayed requests approach 300ms.
    const DELAY = 800;
    const THRESHOLD = 400;

    await injectChaos(page, {
      network: {
        latencies: [{ urlPattern: API_PATTERN, delayMs: DELAY, probability: 1.0, everyNth: 2 }],
      },
    });
    await page.goto(BASE_URL);

    // Request 1: no latency (counter=1)
    const t1Start = Date.now();
    await makeRequest(page);
    const t1 = Date.now() - t1Start;

    // Request 2: latency injected (counter=2)
    const t2Start = Date.now();
    await makeRequest(page);
    const t2 = Date.now() - t2Start;

    // Request 3: no latency again (counter=3)
    const t3Start = Date.now();
    await makeRequest(page);
    const t3 = Date.now() - t3Start;

    expect(t2).toBeGreaterThanOrEqual(DELAY);
    expect(t2 - t1).toBeGreaterThanOrEqual(THRESHOLD);
    expect(t2 - t3).toBeGreaterThanOrEqual(THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// afterN  -  failure fires only after the first N requests pass through
// ---------------------------------------------------------------------------
test.describe('afterN counting', () => {
  test('fetch: first 2 requests succeed, all subsequent fail', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, afterN: 2 }],
      },
    });
    await page.goto(BASE_URL);

    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await makeRequest(page) as string);
    }

    expect(results[0]).toBe('Success!'); // 1  -  before N
    expect(results[1]).toBe('Success!'); // 2  -  before N (count = N, not > N)
    expect(results[2]).toBe('Error!');   // 3  -  after N
    expect(results[3]).toBe('Error!');   // 4
    expect(results[4]).toBe('Error!');   // 5
  });

  test('fetch: afterN 0  -  every request fails', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, afterN: 0 }],
      },
    });
    await page.goto(BASE_URL);

    for (let i = 0; i < 3; i++) {
      const r = await makeRequest(page);
      expect(r).toBe('Error!');
    }
  });

  test('XHR: first 3 succeed, then all fail', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, afterN: 3 }],
      },
    });
    await page.goto(BASE_URL);

    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await makeRequest(page, '#xhr-get', '#xhr-status') as string);
    }

    expect(results[0]).toBe('Success!');
    expect(results[1]).toBe('Success!');
    expect(results[2]).toBe('Success!');
    expect(results[3]).toBe('Error!');
    expect(results[4]).toBe('Error!');
  });
});

// ---------------------------------------------------------------------------
// Cross-transport counting: fetch + XHR share the same counter
// ---------------------------------------------------------------------------
test.describe('cross-transport counting (fetch + XHR share counter)', () => {
  test('onNth=2: counter increments across fetch and XHR together', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, onNth: 2 }],
      },
    });
    await page.goto(BASE_URL);

    // Request 1 via fetch (count=1) → success
    const r1 = await makeRequest(page, '#fetch-data', '#status');
    expect(r1).toBe('Success!');

    // Request 2 via XHR (count=2) → should fail (same counter)
    const r2 = await makeRequest(page, '#xhr-get', '#xhr-status');
    expect(r2).toBe('Error!');

    // Request 3 via fetch (count=3) → success
    const r3 = await makeRequest(page, '#fetch-data', '#status');
    expect(r3).toBe('Success!');
  });
});

// ---------------------------------------------------------------------------
// Counting with probability < 1.0
// ---------------------------------------------------------------------------
test.describe('counting combined with probability', () => {
  test('onNth=3 with probability 0 never fires on any request', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 0, onNth: 3 }],
      },
    });
    await page.goto(BASE_URL);

    for (let i = 0; i < 5; i++) {
      const r = await makeRequest(page);
      expect(r).toBe('Success!');
    }
  });
});
