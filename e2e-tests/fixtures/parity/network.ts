import type { Scenario } from './types';
import { request } from './steps';
import { hasApplied } from './assertions';

/** Network matcher parity scenarios.
 *
 *  Each scenario keeps the fetch / XHR same-origin to the fixture host so the
 *  response is fully readable; negative cases vary the rule (or the request's
 *  query / header / resource kind) rather than the request hostname, which
 *  avoids cross-origin CORS interference on the miss path. */
export const networkScenarios: Scenario[] = [
  {
    id: 'net-hostname-match',
    title: 'network hostname matcher fires on the targeted host',
    transport: 'network',
    config: {
      seed: 42,
      network: {
        failures: [
          { urlPattern: '*', hostname: '127.0.0.1', statusCode: 503, probability: 1 },
        ],
      },
    },
    steps: [request('fetch', '/api/data.json', 'status')],
    check: (ctx, assert) => {
      assert.equal(ctx.captured.status, 503, 'hostname match should inject 503');
      assert.ok(
        hasApplied(ctx.log, 'network:failure'),
        'expected an applied network:failure event',
      );
    },
  },
  {
    id: 'net-hostname-miss',
    title: 'network hostname matcher skips a non-matching host',
    transport: 'network',
    config: {
      seed: 42,
      network: {
        failures: [
          { urlPattern: '*', hostname: 'example.com', statusCode: 503, probability: 1 },
        ],
      },
    },
    steps: [request('fetch', '/api/data.json', 'status')],
    check: (ctx, assert) => {
      assert.equal(
        ctx.captured.status,
        200,
        'hostname mismatch should leave the request untouched',
      );
      assert.ok(
        !hasApplied(ctx.log, 'network:failure'),
        'no network:failure should apply on a non-matching hostname',
      );
    },
  },
  {
    id: 'net-queryparams-match',
    title: 'network queryParams matcher fires when every entry passes',
    transport: 'network',
    config: {
      seed: 42,
      network: {
        failures: [
          {
            urlPattern: '/api/data.json',
            queryParams: { role: 'admin' },
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    },
    steps: [request('fetch', '/api/data.json?role=admin', 'status')],
    check: (ctx, assert) => assert.equal(ctx.captured.status, 503),
  },
  {
    id: 'net-queryparams-miss',
    title: 'network queryParams matcher skips a non-matching value',
    transport: 'network',
    config: {
      seed: 42,
      network: {
        failures: [
          {
            urlPattern: '/api/data.json',
            queryParams: { role: 'admin' },
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    },
    steps: [request('fetch', '/api/data.json?role=user', 'status')],
    check: (ctx, assert) => assert.equal(ctx.captured.status, 200),
  },
  {
    id: 'net-headers-match',
    title: 'network requestHeaders matcher fires case-insensitively',
    transport: 'network',
    config: {
      seed: 42,
      network: {
        failures: [
          {
            urlPattern: '/api/data.json',
            requestHeaders: { 'x-tenant': 'acme' },
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    },
    steps: [request('fetch', '/api/data.json', 'status', { 'X-Tenant': 'acme' })],
    check: (ctx, assert) => assert.equal(ctx.captured.status, 503),
  },
  {
    id: 'net-headers-miss',
    title: 'network requestHeaders matcher skips a request without the header',
    transport: 'network',
    config: {
      seed: 42,
      network: {
        failures: [
          {
            urlPattern: '/api/data.json',
            requestHeaders: { 'x-tenant': 'acme' },
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    },
    steps: [request('fetch', '/api/data.json', 'status')],
    check: (ctx, assert) => assert.equal(ctx.captured.status, 200),
  },
  {
    id: 'net-resourcetype',
    title: 'network resourceTypes matcher restricts a rule to one interceptor',
    transport: 'network',
    config: {
      seed: 42,
      network: {
        failures: [
          {
            urlPattern: '/api/data.json',
            resourceTypes: ['fetch'],
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    },
    steps: [
      request('fetch', '/api/data.json', 'fetchStatus'),
      request('xhr', '/api/data.json', 'xhrStatus'),
    ],
    check: (ctx, assert) => {
      assert.equal(ctx.captured.fetchStatus, 503, 'fetch is in resourceTypes and should fail');
      assert.equal(ctx.captured.xhrStatus, 200, 'xhr is excluded and should pass');
    },
  },
  {
    id: 'net-named-inline',
    title: 'network named matcher inlines its fields into a referencing rule',
    transport: 'network',
    config: {
      seed: 42,
      matchers: {
        customers: { urlPattern: '/api/data.json', queryParams: { type: 'customer' } },
      },
      network: {
        failures: [{ matcher: 'customers', statusCode: 503, probability: 1 }],
      },
    },
    steps: [
      request('fetch', '/api/data.json?type=customer', 'matched'),
      request('fetch', '/api/data.json?type=product', 'missed'),
    ],
    check: (ctx, assert) => {
      assert.equal(ctx.captured.matched, 503);
      assert.equal(ctx.captured.missed, 200);
      assert.ok(hasApplied(ctx.log, 'network:failure'));
    },
  },
  {
    // Companion to `net-named-inline`. Re-uses the same named matcher
    // definition but references it from `network.latencies` instead of
    // `network.failures`, proving the matcher resolves and inlines
    // consistently across distinct rule arrays. A failure rule cannot
    // share this scenario because a synthetic-response rule short-circuits
    // the interceptor before the latency event can record.
    id: 'net-named-latency',
    title: 'network named matcher inlines into a latency rule',
    transport: 'network',
    config: {
      seed: 42,
      matchers: {
        customers: { urlPattern: '/api/data.json', queryParams: { type: 'customer' } },
      },
      network: {
        latencies: [{ matcher: 'customers', delayMs: 25, probability: 1 }],
      },
    },
    steps: [
      request('fetch', '/api/data.json?type=customer', 'matched'),
      request('fetch', '/api/data.json?type=product', 'missed'),
    ],
    check: (ctx, assert) => {
      // Latency does not change the status code, so both requests succeed.
      assert.equal(ctx.captured.matched, 200);
      assert.equal(ctx.captured.missed, 200);
      assert.ok(
        hasApplied(ctx.log, 'network:latency'),
        'latency rule should apply via the named matcher',
      );
    },
  },
];
