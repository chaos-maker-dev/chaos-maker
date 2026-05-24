import type { Scenario } from './types';
import { request } from './steps';

/** Built-in matcher parity scenarios. Covers the three shipped built-ins
 *  (`apiRequests`, `graphql`, `authRequests`) and the override semantics
 *  that let a user matcher of the same name shadow a built-in. */
export const builtInScenarios: Scenario[] = [
  {
    id: 'builtin-api-requests',
    title: 'built-in apiRequests matcher fires on API traffic only',
    transport: 'network',
    config: {
      seed: 42,
      network: {
        failures: [{ matcher: 'apiRequests', statusCode: 503, probability: 1 }],
      },
    },
    steps: [
      request('fetch', '/api/data.json', 'api'),
      request('fetch', '/index.html', 'other'),
    ],
    check: (ctx, assert) => {
      assert.equal(ctx.captured.api, 503, 'apiRequests should match /api traffic');
      assert.equal(ctx.captured.other, 200, 'non-API traffic should be untouched');
    },
  },
  {
    id: 'builtin-graphql',
    title: 'built-in graphql matcher fires on GraphQL endpoint paths only',
    transport: 'network',
    config: {
      seed: 42,
      network: {
        failures: [{ matcher: 'graphql', statusCode: 503, probability: 1 }],
      },
    },
    steps: [
      request('fetch', '/graphql', 'gql'),
      request('fetch', '/api/data.json', 'api'),
    ],
    check: (ctx, assert) => {
      assert.equal(ctx.captured.gql, 503);
      assert.equal(ctx.captured.api, 200);
    },
  },
  {
    id: 'builtin-auth-requests-match',
    title: 'built-in authRequests matcher fires on an authorized request',
    transport: 'network',
    config: {
      seed: 42,
      network: {
        failures: [{ matcher: 'authRequests', statusCode: 503, probability: 1 }],
      },
    },
    steps: [
      request('fetch', '/api/data.json', 'status', { Authorization: 'Bearer token' }),
    ],
    check: (ctx, assert) => assert.equal(ctx.captured.status, 503),
  },
  {
    id: 'builtin-auth-requests-miss',
    title: 'built-in authRequests matcher skips a request with no Authorization header',
    transport: 'network',
    config: {
      seed: 42,
      network: {
        failures: [{ matcher: 'authRequests', statusCode: 503, probability: 1 }],
      },
    },
    steps: [request('fetch', '/api/data.json', 'status')],
    check: (ctx, assert) => assert.equal(ctx.captured.status, 200),
  },
  {
    id: 'builtin-user-override',
    title: 'a user matcher overrides the built-in of the same name',
    transport: 'network',
    config: {
      seed: 42,
      matchers: { graphql: { urlPattern: '/api/data.json' } },
      network: {
        failures: [{ matcher: 'graphql', statusCode: 503, probability: 1 }],
      },
    },
    steps: [
      request('fetch', '/api/data.json', 'overridden'),
      request('fetch', '/graphql', 'builtInPath'),
    ],
    check: (ctx, assert) => {
      assert.equal(
        ctx.captured.overridden,
        503,
        'the user matcher should target /api/data.json',
      );
      assert.notEqual(
        ctx.captured.builtInPath,
        503,
        'the built-in /graphql path is no longer matched',
      );
    },
  },
];
