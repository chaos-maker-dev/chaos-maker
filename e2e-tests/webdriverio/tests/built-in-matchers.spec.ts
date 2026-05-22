import { browser } from '@wdio/globals';

describe('Built-in matchers', () => {
  it('apiRequests built-in fires on API traffic', async () => {
    await browser.url('/');
    await browser.injectChaos({
      seed: 1,
      network: {
        failures: [{ matcher: 'apiRequests', statusCode: 503, probability: 1 }],
      },
    });

    const apiStatus = await browser.execute(async () => {
      const r = await window.fetch('/api/data.json');
      return r.status;
    });
    expect(apiStatus).toBe(503);

    const otherStatus = await browser.execute(async () => {
      const r = await window.fetch('/index.html');
      return r.status;
    });
    expect(otherStatus).toBe(200);
  });

  it('graphql built-in fires on GraphQL endpoint paths', async () => {
    await browser.url('/');
    await browser.injectChaos({
      seed: 1,
      network: {
        failures: [{ matcher: 'graphql', statusCode: 503, probability: 1 }],
      },
    });

    const gqlStatus = await browser.execute(async () => {
      const r = await window.fetch('/graphql');
      return r.status;
    });
    expect(gqlStatus).toBe(503);

    const apiStatus = await browser.execute(async () => {
      const r = await window.fetch('/api/data.json');
      return r.status;
    });
    expect(apiStatus).toBe(200);
  });

  it('authRequests built-in fires only on requests carrying an Authorization header', async () => {
    await browser.url('/');
    await browser.injectChaos({
      seed: 1,
      network: {
        failures: [{ matcher: 'authRequests', statusCode: 503, probability: 1 }],
      },
    });

    const authedStatus = await browser.execute(async () => {
      const r = await window.fetch('/api/data.json', {
        headers: { Authorization: 'Bearer token' },
      });
      return r.status;
    });
    expect(authedStatus).toBe(503);

    const anonStatus = await browser.execute(async () => {
      const r = await window.fetch('/api/data.json');
      return r.status;
    });
    expect(anonStatus).toBe(200);
  });

  it('a user matcher overrides the built-in of the same name', async () => {
    await browser.url('/');
    await browser.injectChaos({
      seed: 1,
      matchers: { graphql: { urlPattern: '/api/data.json' } },
      network: {
        failures: [{ matcher: 'graphql', statusCode: 503, probability: 1 }],
      },
    });

    const overrideTarget = await browser.execute(async () => {
      const r = await window.fetch('/api/data.json');
      return r.status;
    });
    expect(overrideTarget).toBe(503);

    const builtInPath = await browser.execute(async () => {
      const r = await window.fetch('/graphql');
      return r.status;
    });
    expect(builtInPath).not.toBe(503);
  });
});
