# @chaos-maker/playwright

Playwright adapter for [`@chaos-maker/core`](../core/). One-line chaos injection in E2E tests.

## Install

```bash
npm install @chaos-maker/core @chaos-maker/playwright
```

Both packages are required - `@chaos-maker/playwright` loads the core UMD bundle into the browser page.

## Usage

### Direct API

```ts
import { test, expect } from '@playwright/test';
import { injectChaos, removeChaos, getChaosLog } from '@chaos-maker/playwright';

test('shows error when API fails', async ({ page }) => {
  try {
    await injectChaos(page, {
      network: {
        failures: [{ urlPattern: '/api/data', statusCode: 503, probability: 1.0 }]
      }
    });

    await page.goto('/dashboard');
    await expect(page.getByText('Something went wrong')).toBeVisible();

    // Check what chaos was applied
    const log = await getChaosLog(page);
    expect(log.some(e => e.type === 'network:failure' && e.applied)).toBe(true);
  } finally {
    await removeChaos(page);
  }
});
```

For direct API calls, use `try` / `finally` when a test can fail before explicit cleanup. `removeChaos(page)` restores the current document and is safe during teardown. Playwright `addInitScript()` entries stay registered on the `Page`, so a later `page.reload()` or `page.goto()` on the same reused page can run prior chaos init scripts again. Prefer the fixture, Playwright's default fresh page per test, or a new page/context when reload isolation matters.

### Test Fixture

For automatic cleanup, use the built-in fixture:

```ts
import { test, expect } from '@chaos-maker/playwright/fixture';

test('handles slow network', async ({ page, chaos }) => {
  await chaos.inject({
    network: {
      latencies: [{ urlPattern: '/api/', delayMs: 3000, probability: 1.0 }]
    }
  });

  await page.goto('/');
  await expect(page.getByText('Loading')).toBeVisible();

  const log = await chaos.getLog();
  expect(log.some(e => e.type === 'network:latency' && e.applied)).toBe(true);
});
// chaos.remove() is called automatically after each test
```

### With Presets

Drop a built-in preset by name with the declarative `presets` field:

```ts
await injectChaos(page, { presets: ['slow-api'] });
```

Register your own bundle inline via `customPresets`:

```ts
await injectChaos(page, {
  customPresets: {
    'team-flow': {
      network: { failures: [{ urlPattern: '/checkout', statusCode: 503, probability: 1 }] },
    },
  },
  presets: ['team-flow'],
});
```

The legacy spread style still works for migration:

```ts
import { test, expect } from '@playwright/test';
import { presets } from '@chaos-maker/core';
import { injectChaos } from '@chaos-maker/playwright';

test('app works offline', async ({ page }) => {
  await injectChaos(page, presets.offlineMode);
  await page.goto('/');
  await expect(page.getByText('No connection')).toBeVisible();
});
```

### With Config Builder

```ts
import { test } from '@playwright/test';
import { ChaosConfigBuilder } from '@chaos-maker/core';
import { injectChaos } from '@chaos-maker/playwright';

const config = new ChaosConfigBuilder()
  .failRequests('/api/checkout', 500, 0.5)
  .addLatency('/api/', 2000, 1.0)
  .build();

test('checkout handles combined chaos', async ({ page }) => {
  await injectChaos(page, config);
  await page.goto('/checkout');
  // ...
});
```

### Rule Groups

Use Rule Groups to toggle a set of rules during a test without reinjecting chaos.

```ts
import { test, expect } from '@playwright/test';
import { ChaosConfigBuilder } from '@chaos-maker/core';
import {
  injectChaos,
  enableGroup,
  disableGroup,
  enableSWGroup,
  disableSWGroup,
} from '@chaos-maker/playwright';

test('toggles checkout chaos', async ({ page }) => {
  const config = new ChaosConfigBuilder()
    .defineGroup('payments', { enabled: false })
    .inGroup('payments')
    .failRequests('/api/pay', 503, 1)
    .build();

  await injectChaos(page, config);
  await page.goto('/checkout');

  await enableGroup(page, 'payments');
  await expect(page.getByText('Try again')).toBeVisible();

  await disableGroup(page, 'payments');
});
```

With the fixture, the same helpers are available as `chaos.enableGroup(name)` and `chaos.disableGroup(name)`.

For Service Worker rules, use the SW helpers after `injectSWChaos`:

```ts
await enableSWGroup(page, 'payments');
await disableSWGroup(page, 'payments');
```

Browser-side `enableGroup` and `disableGroup` affect page rules from `injectChaos`. `enableSWGroup` and `disableSWGroup` affect Service Worker rules from `injectSWChaos`.

### SSE and GraphQL

```ts
await injectChaos(page, {
  seed: 42,
  sse: {
    drops: [{ urlPattern: '/events', eventType: 'token', probability: 0.1 }],
  },
  network: {
    failures: [{
      urlPattern: '/graphql',
      graphqlOperation: 'GetUser',
      statusCode: 503,
      probability: 1,
    }],
  },
});
await page.goto('/dashboard');
```

SSE chaos and GraphQL operation matching use the same pre-navigation `injectChaos()` timing as fetch, XHR, and WebSocket chaos.

## API

### `injectChaos(page, config, opts?)`

Inject chaos into a Playwright page. **Call before `page.goto()`** to ensure all network requests are intercepted from the start.

- `page` - Playwright `Page` instance
- `config` - `ChaosConfig` object (see [@chaos-maker/core](../core/) for full config reference)
- `opts` - optional. `InjectChaosOptions`:
  - `tracing?: boolean | 'auto'` - emit chaos events into the Playwright trace (see [Debugging with trace](#debugging-with-trace)). Requires `testInfo` when `true`.
  - `testInfo?: TestInfo` - active Playwright `TestInfo` (supplied automatically by the fixture).
  - `traceOptions?: { verbose?: boolean; attachmentName?: string }` - tune trace output.

### `removeChaos(page)`

Stop chaos and restore original `fetch`/`XHR`/DOM behavior.

This restores the active document. It does not remove Playwright `addInitScript()` registrations from a reused `Page`, because Playwright does not expose a removal API for them.

### `getChaosLog(page)`

Retrieve the chaos event log from the page. Returns `ChaosEvent[]` - every chaos check emitted since injection, with `applied: true/false`.

### `enableGroup(page, name)` / `disableGroup(page, name)`

Toggle a browser-side Rule Group at runtime.

### `enableSWGroup(page, name, opts?)` / `disableSWGroup(page, name, opts?)`

Toggle a Service Worker Rule Group at runtime. Pass `opts.timeoutMs` to override the Service Worker acknowledgement timeout.

### Fixture: `chaos`

Available when importing `test` from `@chaos-maker/playwright/fixture`:

- `chaos.inject(config)` - same as `injectChaos(page, config)`
- `chaos.remove()` - same as `removeChaos(page)` (also called automatically after each test)
- `chaos.getLog()` - same as `getChaosLog(page)`
- `chaos.enableGroup(name)` - same as `enableGroup(page, name)`
- `chaos.disableGroup(name)` - same as `disableGroup(page, name)`
- `chaos.enableSWGroup(name, opts?)` - same as `enableSWGroup(page, name, opts)`
- `chaos.disableSWGroup(name, opts?)` - same as `disableSWGroup(page, name, opts)`

## Validation

`injectChaos` validates the config from Node BEFORE any page touch. A malformed config throws `ChaosConfigError` synchronously from the test runner - your test fails before navigation, not in the browser console. `ChaosConfigError.issues` is a structured `ValidationIssue[]` with `path`, `code`, `ruleType`, and optional `expected` / `received`. See the [Rule Validation concept page](https://chaos-maker-dev.github.io/chaos-maker/concepts/validation/).

```ts
import { injectChaos, ChaosConfigError } from '@chaos-maker/playwright';

try {
  await injectChaos(page, config, {
    validation: { unknownFields: 'warn' },
  });
} catch (e) {
  if (e instanceof ChaosConfigError) {
    for (const issue of e.issues) console.error(issue.path, issue.code, issue.message);
  }
  throw e;
}
```

## Debugging with trace

When a chaos test fails, the Playwright trace viewer is the first place to look. Enable tracing in your Playwright config and use the fixture - every applied chaos decision appears inline in the trace action timeline as a `chaos:<type>` step, and the full event log is attached as `chaos-log.json`.

```ts
// playwright.config.ts
export default defineConfig({
  use: {
    trace: 'on-first-retry', // or 'on' / 'retain-on-failure'
  },
});
```

```ts
import { test, expect } from '@chaos-maker/playwright/fixture';

test('flaky checkout', async ({ page, chaos }) => {
  await chaos.inject({
    network: {
      failures: [{ urlPattern: '/api/pay', statusCode: 503, probability: 1.0 }],
    },
  });
  await page.goto('/checkout');
  await page.click('#pay');
  await expect(page.getByText('Order placed')).toBeVisible(); // fails
});
```

On failure, open the trace (`bunx playwright show-trace ...`). You'll see a step like:

> `chaos:network:failure /api/pay → 503`

…alongside the `page.click` and the failing assertion. The `chaos-log.json` attachment contains the full event stream plus the PRNG seed for exact replay.

**Tracing is auto-enabled** by the fixture whenever your project's `use.trace` is anything other than `'off'`. Opt out per-call with `chaos.inject(config, { tracing: false })`.

**Direct API users** must supply `testInfo` explicitly:

```ts
import { injectChaos } from '@chaos-maker/playwright';
import { test } from '@playwright/test';

test('with direct API', async ({ page }, testInfo) => {
  await injectChaos(page, config, { tracing: true, testInfo });
  // ...
});
```

## Leak diagnostics

Enable `debug: true` on the chaos config to surface leaked-runtime diagnostics in the event log. Filter `getChaosLog(page)` for `type === 'debug'` events with `detail.reason` covering double-patched globals, stale wrapper handles, orphaned observers, or active-instance conflicts. See [`@chaos-maker/core`](../core/README.md#leak-diagnostics) for the full reason list.

```ts
await injectChaos(page, { debug: true, network: { /* ... */ } });
await page.goto('/');
const issues = (await getChaosLog(page)).filter(
  (e) => e.type === 'debug' && /already-patched|stale|orphaned|active-instance-conflict/.test(String(e.detail.reason ?? '')),
);
```

## Service Worker chaos

Intercept SW-originated fetches. Requires one line in your service-worker script.

```js
// user's sw.js (classic)
importScripts('/chaos-maker-sw.js');
```

```ts
import {
  injectSWChaos,
  removeSWChaos,
  getSWChaosLog,
  getSWChaosLogFromSW,
  enableSWGroup,
  disableSWGroup,
} from '@chaos-maker/playwright';

test('SW-fetched /api returns 503', async ({ page }) => {
  await page.goto('/app-with-sw/');
  // wait for controller after your app's SW registration
  await injectSWChaos(page, {
    groups: [{ name: 'payments', enabled: false }],
    network: {
      failures: [{ urlPattern: '/api/data', statusCode: 503, probability: 1, group: 'payments' }],
    },
    seed: 1,
  });
  await enableSWGroup(page, 'payments');
  await page.click('#trigger');
  const log = await getSWChaosLog(page);
  expect(log.some(e => e.type === 'network:failure' && e.applied)).toBe(true);
  await disableSWGroup(page, 'payments');
  await removeSWChaos(page);
});
```

Use `getSWChaosLog(page)` for the page-buffered event log. This is the default assertion surface because it reflects events broadcast from the Service Worker to the page. Use `getSWChaosLogFromSW(page)` when you need a direct pull from the Service Worker's in-memory log, such as debugging a missed page-side broadcast.

`removeSWChaos(page)` stops the worker engine and clears both the page-buffered and worker-side logs. For full browser isolation between tests, unregister the app's Service Worker or use a fresh browser context.

Two artifacts ship in `@chaos-maker/core`:
- `dist/sw.js` - IIFE bundle for classic SWs (`importScripts('/chaos-maker-sw.js')`).
- `dist/sw.mjs` - ESM bundle for module SWs (`import { installChaosSW } from '/chaos-maker-sw.mjs'`).

Serve whichever your SW type uses at a URL reachable from the service-worker scope.

## License

[MIT](../../LICENSE)
