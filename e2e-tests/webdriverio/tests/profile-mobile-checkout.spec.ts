import { browser, $ } from '@wdio/globals';
import type { ChaosEvent } from '@chaos-maker/core';

describe('Profile: mobileCheckout', () => {
  it('built-in profile composes mobile-3g latency on the request path', async () => {
    await browser.url('/');
    await browser.injectChaos({ profile: 'mobile-checkout', seed: 1234 });
    await $('#fetch-data').click();
    await expect($('#status')).toHaveText('Success!');

    const timing = await $('#timing').getText();
    expect(parseInt(timing, 10)).toBeGreaterThan(1000);

    const log = (await browser.getChaosLog()) as ChaosEvent[];
    expect(log.some((e) => e.type === 'network:latency' && e.applied)).toBe(true);
  });

  it('camelCase mobileCheckout resolves to the same profile', async () => {
    await browser.url('/');
    await browser.injectChaos({ profile: 'mobileCheckout', seed: 1234 });
    await $('#fetch-data').click();
    await expect($('#status')).toHaveText('Success!');

    const log = (await browser.getChaosLog()) as ChaosEvent[];
    expect(log.some((e) => e.type === 'network:latency')).toBe(true);
  });
});
