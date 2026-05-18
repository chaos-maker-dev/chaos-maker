import { browser } from '@wdio/globals';

describe('Advanced matchers', () => {
  it('hostname matcher fires for matching host', async () => {
    await browser.url('/');
    await browser.injectChaos({
      seed: 1,
      network: {
        failures: [
          {
            urlPattern: '*',
            hostname: '127.0.0.1',
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    });
    const status = await browser.execute(async () => {
      const r = await window.fetch('/api/data.json');
      return r.status;
    });
    expect(status).toBe(503);
  });

  it('named matcher inlines into a referencing rule', async () => {
    await browser.url('/');
    await browser.injectChaos({
      seed: 1,
      matchers: {
        customers: { urlPattern: '/api/data.json', queryParams: { type: 'customer' } },
      },
      network: {
        failures: [
          { matcher: 'customers', statusCode: 503, probability: 1 },
        ],
      },
    });
    const matched = await browser.execute(async () => {
      const r = await window.fetch('/api/data.json?type=customer');
      return r.status;
    });
    expect(matched).toBe(503);
    const missed = await browser.execute(async () => {
      const r = await window.fetch('/api/data.json?type=product');
      return r.status;
    });
    expect(missed).toBe(200);
  });
});
