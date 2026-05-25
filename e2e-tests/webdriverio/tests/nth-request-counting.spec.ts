import { browser, $ } from '@wdio/globals';
import type { ChaosEvent } from '@chaos-maker/core';

const API_PATTERN = '/api/data.json';

async function makeRequest(buttonId = '#fetch-data', statusId = '#status'): Promise<void> {
  await $(buttonId).click();
  await browser.waitUntil(async () => (await $(statusId).getText()) !== 'Loading...', {
    timeout: 5000,
    timeoutMsg: `${statusId} stuck in Loading...`,
  });
}

describe('onNth counting', () => {
  it('fetch: fails only on the 3rd request', async () => {
    await browser.url('/');
    await browser.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, onNth: 3 }] },
    });

    await makeRequest();
    await expect($('#status')).toHaveText('Success!');
    await makeRequest();
    await expect($('#status')).toHaveText('Success!');
    await makeRequest();
    await expect($('#status')).toHaveText('Error!');
    await makeRequest();
    await expect($('#status')).toHaveText('Success!');

    const log = (await browser.getChaosLog()) as ChaosEvent[];
    const failures = log.filter((e) => e.type === 'network:failure');
    expect(failures.length).toBe(1);
    expect(failures[0].applied).toBe(true);
  });

  it('fetch: fails only on the 1st request when onNth is 1', async () => {
    await browser.url('/');
    await browser.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 500, probability: 1.0, onNth: 1 }] },
    });

    await makeRequest();
    await expect($('#status')).toHaveText('Error!');
    await makeRequest();
    await expect($('#status')).toHaveText('Success!');
    await makeRequest();
    await expect($('#status')).toHaveText('Success!');
  });

  it('XHR: fails only on the 2nd request', async () => {
    await browser.url('/');
    await browser.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, onNth: 2 }] },
    });

    await makeRequest('#xhr-get', '#xhr-status');
    await expect($('#xhr-status')).toHaveText('Success!');
    await makeRequest('#xhr-get', '#xhr-status');
    await expect($('#xhr-status')).toHaveText('Error!');
    await makeRequest('#xhr-get', '#xhr-status');
    await expect($('#xhr-status')).toHaveText('Success!');
  });
});

describe('everyNth counting', () => {
  it('fetch: fails on every 2nd request', async () => {
    await browser.url('/');
    await browser.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, everyNth: 2 }] },
    });

    const expected = ['Success!', 'Error!', 'Success!', 'Error!', 'Success!', 'Error!'];
    for (const want of expected) {
      await makeRequest();
      await expect($('#status')).toHaveText(want);
    }
  });

  it('fetch: fails on every 3rd request', async () => {
    await browser.url('/');
    await browser.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, everyNth: 3 }] },
    });

    const expected = ['Success!', 'Success!', 'Error!', 'Success!', 'Success!', 'Error!'];
    for (const want of expected) {
      await makeRequest();
      await expect($('#status')).toHaveText(want);
    }
  });

  it('fetch: latency applied on every 2nd request', async () => {
    const DELAY = 800;
    const THRESHOLD = 500;

    await browser.url('/');
    await browser.injectChaos({
      network: { latencies: [{ urlPattern: API_PATTERN, delayMs: DELAY, probability: 1.0, everyNth: 2 }] },
    });

    await makeRequest();
    const t1 = parseInt(await $('#timing').getText(), 10);

    await makeRequest();
    const t2 = parseInt(await $('#timing').getText(), 10);

    await makeRequest();
    const t3 = parseInt(await $('#timing').getText(), 10);

    expect(t2).toBeGreaterThanOrEqual(DELAY);
    expect(t2 - t1).toBeGreaterThanOrEqual(THRESHOLD);
    expect(t2 - t3).toBeGreaterThanOrEqual(THRESHOLD);
  });
});

describe('afterN counting', () => {
  it('fetch: first 2 requests succeed, all subsequent fail', async () => {
    await browser.url('/');
    await browser.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, afterN: 2 }] },
    });

    const expected = ['Success!', 'Success!', 'Error!', 'Error!', 'Error!'];
    for (const want of expected) {
      await makeRequest();
      await expect($('#status')).toHaveText(want);
    }
  });

  it('fetch: afterN 0  -  every request fails', async () => {
    await browser.url('/');
    await browser.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, afterN: 0 }] },
    });

    for (let i = 0; i < 3; i++) {
      await makeRequest();
      await expect($('#status')).toHaveText('Error!');
    }
  });

  it('XHR: first 3 succeed, then all fail', async () => {
    await browser.url('/');
    await browser.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, afterN: 3 }] },
    });

    const expected = ['Success!', 'Success!', 'Success!', 'Error!', 'Error!'];
    for (const want of expected) {
      await makeRequest('#xhr-get', '#xhr-status');
      await expect($('#xhr-status')).toHaveText(want);
    }
  });
});

describe('cross-transport counting (fetch + XHR share counter)', () => {
  it('onNth=2: counter increments across fetch and XHR together', async () => {
    await browser.url('/');
    await browser.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, onNth: 2 }] },
    });

    await makeRequest('#fetch-data', '#status');
    await expect($('#status')).toHaveText('Success!');

    await makeRequest('#xhr-get', '#xhr-status');
    await expect($('#xhr-status')).toHaveText('Error!');

    await makeRequest('#fetch-data', '#status');
    await expect($('#status')).toHaveText('Success!');
  });
});

describe('counting combined with probability', () => {
  it('onNth=3 with probability 0 never fires on any request', async () => {
    await browser.url('/');
    await browser.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 0, onNth: 3 }] },
    });

    for (let i = 0; i < 5; i++) {
      await makeRequest();
      await expect($('#status')).toHaveText('Success!');
    }
  });
});
