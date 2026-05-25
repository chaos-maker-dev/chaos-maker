# @chaos-maker/puppeteer

Puppeteer adapter for [`@chaos-maker/core`](https://github.com/chaos-maker-dev/chaos-maker). Inject network, UI, WebSocket, Service Worker, SSE, and GraphQL operation chaos into Puppeteer tests.

## Install

```bash
npm install --save-dev @chaos-maker/puppeteer puppeteer
# or
bun add -D @chaos-maker/puppeteer puppeteer
```

## Quick start

```ts
import puppeteer from 'puppeteer';
import { injectChaos, getChaosLog } from '@chaos-maker/puppeteer';

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();

// Inject BEFORE goto - uses evaluateOnNewDocument for full-lifecycle coverage
await injectChaos(page, {
  network: {
    failures: [{ urlPattern: '/api', statusCode: 503, probability: 1.0 }],
  },
});

await page.goto('http://localhost:3000');
// ... drive the page ...
const log = await getChaosLog(page);
console.log('Chaos events:', log);

await browser.close();
```

## API

### `injectChaos(page, config)`

Injects chaos into a Puppeteer page via `evaluateOnNewDocument`. Must be called before `page.goto()` so all network requests are intercepted from the start.

### `removeChaos(page)`

Stops chaos and restores original `fetch`, `XMLHttpRequest`, `WebSocket`, and DOM behaviour. Safe to call after page close.

When Puppeteer exposes init-script identifiers, cleanup also removes registered `evaluateOnNewDocument` scripts so a later reload on a reused page does not re-inject old chaos. Fresh pages per test are still the simplest isolation pattern.

### `getChaosLog(page)`

Returns the full event log (applied + skipped decisions) since `injectChaos` was called.

### `getChaosSeed(page)`

Returns the PRNG seed used by the active chaos instance. Log this on test failure to replay the exact sequence.

### `enableGroup(page, name)` / `disableGroup(page, name)`

Enable or disable a browser-side Rule Group at runtime. The promise resolves after the page evaluates the toggle.

```ts
import { ChaosConfigBuilder } from '@chaos-maker/core';
import { injectChaos, enableGroup, disableGroup } from '@chaos-maker/puppeteer';

const config = new ChaosConfigBuilder()
  .defineGroup('payments', { enabled: false })
  .inGroup('payments')
  .failRequests('/api/pay', 503, 1)
  .build();

await injectChaos(page, config);
await page.goto('http://localhost:3000/checkout');

await enableGroup(page, 'payments');
await disableGroup(page, 'payments');
```

### `useChaos(page, config)`

Convenience helper for `afterEach`-style cleanup - injects chaos and returns an async teardown:

```ts
let teardown: () => Promise<void>;
beforeEach(async () => {
  teardown = await useChaos(page, { network: { failures: [...] } });
});
afterEach(() => teardown());
```

Use `try` / `finally` around direct calls when a test may fail before cleanup:

```ts
try {
  await injectChaos(page, config);
  await page.goto('http://localhost:3000');
  // assertions
} finally {
  await removeChaos(page);
}
```

## Validation

`injectChaos` validates the config from Node before `evaluateOnNewDocument` runs. A malformed config throws `ChaosConfigError` synchronously from the test runner. `ChaosConfigError.issues` is a structured `ValidationIssue[]`. See the [Rule Validation concept page](https://chaos-maker-dev.github.io/chaos-maker/concepts/validation/).

```ts
await injectChaos(page, config, {
  validation: { unknownFields: 'warn' },
});
```

## Presets

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

Built-in catalog and validation rules are documented in [`@chaos-maker/core`](../core/README.md#presets).

## Leak diagnostics

Set `debug: true` on the chaos config to surface leaked-runtime diagnostics in the event log. Filter `getChaosLog(page)` for `type === 'debug'` events with `detail.reason` covering double-patched globals, stale wrapper handles, orphaned observers, or active-instance conflicts. See [`@chaos-maker/core`](../core/README.md#leak-diagnostics) for the full reason list.

```ts
await injectChaos(page, { debug: true, network: { /* ... */ } });
await page.goto('http://localhost:3000');
const issues = (await getChaosLog(page)).filter(
  (e) => e.type === 'debug' && /already-patched|stale|orphaned|active-instance-conflict/.test(String(e.detail.reason ?? '')),
);
```

## Service Worker chaos

```ts
import {
  injectSWChaos,
  removeSWChaos,
  getSWChaosLog,
  getSWChaosLogFromSW,
  enableSWGroup,
  disableSWGroup,
} from '@chaos-maker/puppeteer';

await page.goto('http://localhost:3000/app-with-sw/');
await page.waitForFunction(() => !!navigator.serviceWorker.controller);
await injectSWChaos(page, {
  groups: [{ name: 'payments', enabled: false }],
  network: {
    failures: [{ urlPattern: '/api/data', statusCode: 503, probability: 1, group: 'payments' }],
  },
  seed: 1,
});
await enableSWGroup(page, 'payments');
// ...interact...
const log = await getSWChaosLog(page);
await disableSWGroup(page, 'payments');
await removeSWChaos(page);
```

Use `getSWChaosLog(page)` for the page-buffered event log. This is the default assertion surface because it reflects events broadcast from the Service Worker to the page. Use `getSWChaosLogFromSW(page)` when you need a direct pull from the Service Worker's in-memory log, such as debugging a missed page-side broadcast.

`removeSWChaos(page)` stops the worker engine and clears both the page-buffered and worker-side logs. Unregister the app's Service Worker when you need a completely fresh registration between tests.

User's SW must `importScripts('/chaos-maker-sw.js')` (classic) or `import { installChaosSW } from '@chaos-maker/core/sw'` (module).

Browser-side `enableGroup` and `disableGroup` affect page rules from `injectChaos`. `enableSWGroup` and `disableSWGroup` affect Service Worker rules from `injectSWChaos`.

## SSE and GraphQL

```ts
await injectChaos(page, {
  seed: 42,
  sse: {
    closes: [{ urlPattern: '/events', afterMs: 2000, probability: 0.02 }],
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
await page.goto('http://localhost:3000/dashboard');
```

SSE chaos and GraphQL operation matching use the same pre-navigation `injectChaos()` timing as fetch, XHR, and WebSocket chaos.

## Notes

- **Headless Chromium only** (headless-new mode, Puppeteer 21+). Firefox via `puppeteer-core` is untested.
- Trace viewer integration (surfacing chaos events in a trace timeline) is not available in this adapter - use `@chaos-maker/playwright` if you need traces.
- Works with both `puppeteer` and `puppeteer-core` - the type is structural.
