import { test, expect } from '@playwright/test';
import { injectChaos, getChaosLog } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';
const API_PATTERN = '/api/data.json';

// ---------------------------------------------------------------------------
// Network Failures
// ---------------------------------------------------------------------------
test.describe('Network Failures', () => {
  test('injects failure with 503 status', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Error!');
    await expect(page.locator('#result')).toContainText('503');

    const log = await getChaosLog(page);
    expect(log.some(e => e.type === 'network:failure' && e.applied)).toBe(true);
  });

  test('injects failure with custom body and status text', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{
          urlPattern: API_PATTERN,
          statusCode: 429,
          probability: 1.0,
          body: '{"error":"rate limited"}',
          statusText: 'Too Many Requests',
        }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Error!');
    await expect(page.locator('#result')).toContainText('429');
  });

  test('passes through when probability is 0', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 500, probability: 0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Success!');
  });

  test('applies failure only to matching HTTP methods', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{
          urlPattern: API_PATTERN,
          statusCode: 500,
          probability: 1.0,
          methods: ['POST'],
        }],
      },
    });
    await page.goto(BASE_URL);

    // GET should pass through
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Success!');

    // POST should fail
    await page.click('#fetch-post');
    await expect(page.locator('#status')).toHaveText('Error!');
    await expect(page.locator('#result')).toContainText('500');
  });

  test('does not affect non-matching URLs', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: '/no-match', statusCode: 500, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Success!');
  });

  test('injects failure on XHR requests', async ({ page }) => {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: API_PATTERN, statusCode: 500, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#xhr-get');

    await expect(page.locator('#xhr-status')).toHaveText('Error!');
    await expect(page.locator('#xhr-result')).toContainText('500');
  });
});

// ---------------------------------------------------------------------------
// Network Latency
// ---------------------------------------------------------------------------
test.describe('Network Latency', () => {
  test('adds delay to fetch requests', async ({ page }) => {
    const delayMs = 500;
    await injectChaos(page, {
      network: {
        latencies: [{ urlPattern: API_PATTERN, delayMs, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Success!');
    const timing = await page.locator('#timing').textContent();
    const elapsed = parseInt(timing!);
    expect(elapsed).toBeGreaterThanOrEqual(delayMs - 100);
  });

  test('logs latency event', async ({ page }) => {
    await injectChaos(page, {
      network: {
        latencies: [{ urlPattern: API_PATTERN, delayMs: 100, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Success!');

    const log = await getChaosLog(page);
    const latencyEvent = log.find(e => e.type === 'network:latency' && e.applied);
    expect(latencyEvent).toBeTruthy();
    expect(latencyEvent!.detail).toHaveProperty('delayMs', 100);
  });

  test('skips latency when probability is 0', async ({ page }) => {
    await injectChaos(page, {
      network: {
        latencies: [{ urlPattern: API_PATTERN, delayMs: 2000, probability: 0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Success!');

    const timing = await page.locator('#timing').textContent();
    const elapsed = parseInt(timing!);
    // Should complete quickly without the 2s delay
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Connection Abort
// ---------------------------------------------------------------------------
test.describe('Connection Abort', () => {
  test('aborts fetch requests immediately', async ({ page }) => {
    await injectChaos(page, {
      network: {
        aborts: [{ urlPattern: API_PATTERN, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Error!');
    await expect(page.locator('#result')).toContainText('aborted');

    const log = await getChaosLog(page);
    expect(log.some(e => e.type === 'network:abort' && e.applied)).toBe(true);
  });

  test('aborts XHR requests', async ({ page }) => {
    await injectChaos(page, {
      network: {
        aborts: [{ urlPattern: API_PATTERN, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#xhr-get');

    await expect(page.locator('#xhr-status')).toHaveText('Aborted!');
  });

  test('records timeout in abort event detail', async ({ page }) => {
    await injectChaos(page, {
      network: {
        aborts: [{ urlPattern: API_PATTERN, probability: 1.0, timeout: 200 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    // Wait for the fetch to actually complete (not just "Loading..." from click handler)
    await page.locator('#timing').filter({ hasNotText: '' }).waitFor();

    const log = await getChaosLog(page);
    const abortEvent = log.find(e => e.type === 'network:abort');
    expect(abortEvent).toBeTruthy();
    expect(abortEvent!.detail.timeoutMs).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Response Corruption
// ---------------------------------------------------------------------------
test.describe('Response Corruption', () => {
  test('truncates response body', async ({ page }) => {
    await injectChaos(page, {
      network: {
        corruptions: [{ urlPattern: API_PATTERN, strategy: 'truncate', probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Parse Error!');
    const result = await page.locator('#result').textContent();
    // Truncated to ~half length  -  original is ~60 chars
    expect(result!.length).toBeGreaterThan(0);
    expect(result!.length).toBeLessThan(50);

    const log = await getChaosLog(page);
    expect(log.some(e => e.type === 'network:corruption' && e.applied)).toBe(true);
  });

  test('injects malformed JSON', async ({ page }) => {
    await injectChaos(page, {
      network: {
        corruptions: [{ urlPattern: API_PATTERN, strategy: 'malformed-json', probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Parse Error!');
    const result = await page.locator('#result').textContent();
    // malformed-json appends "}
    expect(result).toContain('"}');
  });

  test('replaces response with empty body', async ({ page }) => {
    await injectChaos(page, {
      network: {
        corruptions: [{ urlPattern: API_PATTERN, strategy: 'empty', probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Parse Error!');
    const result = await page.locator('#result').textContent();
    expect(result).toBe('');
  });

  test('replaces response with unexpected HTML', async ({ page }) => {
    await injectChaos(page, {
      network: {
        corruptions: [{ urlPattern: API_PATTERN, strategy: 'wrong-type', probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Parse Error!');
    const result = await page.locator('#result').textContent();
    expect(result).toContain('Unexpected HTML');
  });
});

// ---------------------------------------------------------------------------
// CORS Simulation
// ---------------------------------------------------------------------------
test.describe('CORS Simulation', () => {
  test('simulates CORS failure on fetch', async ({ page }) => {
    await injectChaos(page, {
      network: {
        cors: [{ urlPattern: API_PATTERN, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#fetch-data');

    await expect(page.locator('#status')).toHaveText('Error!');
    await expect(page.locator('#result')).toContainText('Failed to fetch');

    const log = await getChaosLog(page);
    expect(log.some(e => e.type === 'network:cors' && e.applied)).toBe(true);
  });

  test('simulates CORS failure on XHR', async ({ page }) => {
    await injectChaos(page, {
      network: {
        cors: [{ urlPattern: API_PATTERN, probability: 1.0 }],
      },
    });
    await page.goto(BASE_URL);
    await page.click('#xhr-get');

    await expect(page.locator('#xhr-status')).toHaveText('Error!');
    await expect(page.locator('#xhr-result')).toContainText('Network Error');
  });

  test('applies CORS only to matching methods', async ({ page }) => {
    await injectChaos(page, {
      network: {
        cors: [{ urlPattern: API_PATTERN, probability: 1.0, methods: ['POST'] }],
      },
    });
    await page.goto(BASE_URL);

    // GET should pass through
    await page.click('#fetch-data');
    await expect(page.locator('#status')).toHaveText('Success!');

    // POST should be blocked
    await page.click('#fetch-post');
    await expect(page.locator('#status')).toHaveText('Error!');
    await expect(page.locator('#result')).toContainText('Failed to fetch');
  });
});
