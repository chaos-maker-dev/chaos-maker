import { browser, $ } from '@wdio/globals';
import type { ChaosEvent } from '@chaos-maker/core';

async function wsInboundCount(): Promise<number> {
  return Number(await $('#ws-inbound-count').getText());
}

async function sseMessageCount(): Promise<number> {
  return Number(await $('#sse-message-count').getText());
}

describe('Cross-transport matchers', () => {
  it('WS named matcher fires when hostname matches registered entry', async () => {
    await browser.url('/');
    await browser.injectChaos({
      seed: 42,
      matchers: { realtime: { hostname: '127.0.0.1' } },
      websocket: {
        drops: [
          { matcher: 'realtime', direction: 'outbound', probability: 1 },
        ],
      },
    });
    await $('#ws-connect').click();
    await expect($('#ws-status')).toHaveText('open');
    await $('#ws-send').click();
    await browser.pause(500);
    expect(await wsInboundCount()).toBe(0);

    const log = (await browser.getChaosLog()) as ChaosEvent[];
    const drops = log.filter((e) => e.type === 'websocket:drop' && e.applied);
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  it('WS inline queryParams fires for ?room=alpha and skips for ?room=beta', async () => {
    await browser.url('/');
    await browser.injectChaos({
      seed: 42,
      websocket: {
        drops: [
          {
            urlPattern: '127.0.0.1:8081',
            direction: 'outbound',
            queryParams: { room: 'alpha' },
            probability: 1,
          },
        ],
      },
    });
    await $('#ws-connect-alpha').click();
    await expect($('#ws-status')).toHaveText('open');
    await $('#ws-send').click();
    await browser.pause(500);
    expect(await wsInboundCount()).toBe(0);

    // Same config, different room → chaos must NOT fire.
    await browser.removeChaos();
    await browser.url('/');
    await browser.injectChaos({
      seed: 42,
      websocket: {
        drops: [
          {
            urlPattern: '127.0.0.1:8081',
            direction: 'outbound',
            queryParams: { room: 'alpha' },
            probability: 1,
          },
        ],
      },
    });
    await $('#ws-connect-beta').click();
    await expect($('#ws-status')).toHaveText('open');
    await $('#ws-send').click();
    await browser.waitUntil(async () => (await wsInboundCount()) === 1, {
      timeout: 5_000,
      timeoutMsg: 'beta echo never arrived',
    });
  });

  it('SSE named matcher fires on registered hostname', async () => {
    await browser.url('/');
    await browser.injectChaos({
      seed: 42,
      matchers: { feed: { hostname: '127.0.0.1' } },
      sse: {
        drops: [{ matcher: 'feed', probability: 1 }],
      },
    });
    await $('#sse-connect-alerts').click();
    await expect($('#sse-status')).toHaveText('open');
    await browser.pause(1000);
    expect(await sseMessageCount()).toBe(0);

    const log = (await browser.getChaosLog()) as ChaosEvent[];
    const drops = log.filter((e) => e.type === 'sse:drop' && e.applied);
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  it('SSE inline queryParams fires for ?topic=alerts and skips for ?topic=quotes', async () => {
    await browser.url('/');
    await browser.injectChaos({
      seed: 42,
      sse: {
        drops: [
          {
            urlPattern: '/sse-topics',
            queryParams: { topic: 'alerts' },
            probability: 1,
          },
        ],
      },
    });
    await $('#sse-connect-alerts').click();
    await expect($('#sse-status')).toHaveText('open');
    await browser.pause(1000);
    expect(await sseMessageCount()).toBe(0);

    await browser.removeChaos();
    await browser.url('/');
    await browser.injectChaos({
      seed: 42,
      sse: {
        drops: [
          {
            urlPattern: '/sse-topics',
            queryParams: { topic: 'alerts' },
            probability: 1,
          },
        ],
      },
    });
    await $('#sse-connect-quotes').click();
    await expect($('#sse-status')).toHaveText('open');
    await browser.waitUntil(async () => (await sseMessageCount()) >= 1, {
      timeout: 5_000,
      timeoutMsg: 'quotes stream did not deliver messages',
    });
  });

  it('debug event surfaces matcherName and matchedBy on WS drop', async () => {
    await browser.url('/');
    await browser.injectChaos({
      seed: 42,
      debug: true,
      matchers: { realtime: { hostname: '127.0.0.1' } },
      websocket: {
        drops: [
          { matcher: 'realtime', direction: 'outbound', probability: 1 },
        ],
      },
    });
    await $('#ws-connect').click();
    await expect($('#ws-status')).toHaveText('open');
    await $('#ws-send').click();
    await browser.pause(300);

    const log = (await browser.getChaosLog()) as ChaosEvent[];
    const matched = log.find(
      (e) =>
        e.type === 'debug' &&
        e.detail.stage === 'rule-matched' &&
        e.detail.matcherName === 'realtime' &&
        Array.isArray(e.detail.matchedBy) &&
        (e.detail.matchedBy as string[]).includes('hostname'),
    );
    expect(matched).toBeDefined();
  });
});
