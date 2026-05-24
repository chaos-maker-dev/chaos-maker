import type { Scenario } from './types';
import { click, waitForText, waitForCount, expectText, settle } from './steps';
import { hasApplied } from './assertions';

/** Server-Sent Events matcher parity scenarios. The fixture's SSE topic
 *  streams expose `#sse-connect-alerts` / `#sse-connect-quotes` buttons and
 *  surface a per-connection message count on `#sse-message-count`. */
export const sseScenarios: Scenario[] = [
  {
    id: 'sse-named-hostname',
    title: 'sse named matcher fires on a registered hostname',
    transport: 'sse',
    config: {
      seed: 42,
      matchers: { feed: { hostname: '127.0.0.1' } },
      sse: { drops: [{ matcher: 'feed', probability: 1 }] },
    },
    steps: [
      click('#sse-connect-alerts'),
      waitForText('#sse-status', 'open'),
      settle(1000),
      expectText('#sse-message-count', '0'),
    ],
    check: (ctx, assert) =>
      assert.ok(hasApplied(ctx.log, 'sse:drop'), 'expected an applied sse:drop event'),
  },
  {
    id: 'sse-queryparams-fires',
    title: 'sse queryParams matcher fires on a matching stream',
    transport: 'sse',
    config: {
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
    },
    steps: [
      click('#sse-connect-alerts'),
      waitForText('#sse-status', 'open'),
      settle(1000),
      expectText('#sse-message-count', '0'),
    ],
    check: (ctx, assert) =>
      assert.ok(hasApplied(ctx.log, 'sse:drop'), 'expected an applied sse:drop event'),
  },
  {
    id: 'sse-queryparams-skips',
    title: 'sse queryParams matcher skips a non-matching stream',
    transport: 'sse',
    config: {
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
    },
    steps: [
      click('#sse-connect-quotes'),
      waitForText('#sse-status', 'open'),
      waitForCount('#sse-message-count', 1),
    ],
    check: (ctx, assert) =>
      assert.ok(
        !hasApplied(ctx.log, 'sse:drop'),
        'no sse:drop should apply on a non-matching topic',
      ),
  },
];
