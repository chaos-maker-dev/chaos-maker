import type { Scenario } from './types';
import { click, waitForText, waitForCount, expectText, settle } from './steps';
import { hasApplied, hasDebugMatchedBy } from './assertions';

/** WebSocket matcher parity scenarios. The fixture's WebSocket connection
 *  fires through the `#ws-connect{,-alpha,-beta}` buttons; the inbound echo
 *  count on `#ws-inbound-count` is the observable for whether chaos dropped
 *  the outbound `ping`. */
export const webSocketScenarios: Scenario[] = [
  {
    id: 'ws-named-hostname',
    title: 'websocket named matcher fires on a registered hostname',
    transport: 'websocket',
    config: {
      seed: 42,
      matchers: { realtime: { hostname: '127.0.0.1' } },
      websocket: {
        drops: [{ matcher: 'realtime', direction: 'outbound', probability: 1 }],
      },
    },
    steps: [
      click('#ws-connect'),
      waitForText('#ws-status', 'open'),
      click('#ws-send'),
      settle(500),
      expectText('#ws-inbound-count', '0'),
    ],
    check: (ctx, assert) =>
      assert.ok(
        hasApplied(ctx.log, 'websocket:drop'),
        'expected an applied websocket:drop event',
      ),
  },
  {
    id: 'ws-queryparams-fires',
    title: 'websocket queryParams matcher fires on a matching connection',
    transport: 'websocket',
    config: {
      seed: 42,
      websocket: {
        drops: [
          {
            urlPattern: '127.0.0.1:8081',
            queryParams: { room: 'alpha' },
            direction: 'outbound',
            probability: 1,
          },
        ],
      },
    },
    steps: [
      click('#ws-connect-alpha'),
      waitForText('#ws-status', 'open'),
      click('#ws-send'),
      settle(500),
      expectText('#ws-inbound-count', '0'),
    ],
    check: (ctx, assert) =>
      assert.ok(
        hasApplied(ctx.log, 'websocket:drop'),
        'expected an applied websocket:drop event',
      ),
  },
  {
    id: 'ws-queryparams-skips',
    title: 'websocket queryParams matcher skips a non-matching connection',
    transport: 'websocket',
    config: {
      seed: 42,
      websocket: {
        drops: [
          {
            urlPattern: '127.0.0.1:8081',
            queryParams: { room: 'alpha' },
            direction: 'outbound',
            probability: 1,
          },
        ],
      },
    },
    steps: [
      click('#ws-connect-beta'),
      waitForText('#ws-status', 'open'),
      click('#ws-send'),
      // First wait for the echo to arrive (count >= 1), then assert the
      // count is exactly `1`. A `>= 1` check alone would mask a duplicate-
      // message regression where the echo arrives twice.
      waitForCount('#ws-inbound-count', 1),
      expectText('#ws-inbound-count', '1'),
    ],
    check: (ctx, assert) =>
      assert.ok(
        !hasApplied(ctx.log, 'websocket:drop'),
        'no websocket:drop should apply on a non-matching room',
      ),
  },
  {
    id: 'ws-debug-matchedby',
    title: 'websocket debug event reports hostname in matchedBy attribution',
    transport: 'websocket',
    config: {
      seed: 42,
      debug: true,
      websocket: {
        drops: [
          {
            urlPattern: '127.0.0.1:8081',
            hostname: '127.0.0.1',
            direction: 'outbound',
            probability: 1,
          },
        ],
      },
    },
    steps: [
      click('#ws-connect'),
      waitForText('#ws-status', 'open'),
      click('#ws-send'),
      settle(300),
    ],
    check: (ctx, assert) =>
      assert.ok(
        hasDebugMatchedBy(ctx.log, 'hostname'),
        'expected a rule-matched debug event citing hostname',
      ),
  },
];
