# Chaos Maker

[![Build Status](https://github.com/chaos-maker-dev/chaos-maker/actions/workflows/ci.yml/badge.svg)](https://github.com/chaos-maker-dev/chaos-maker/actions)
[![npm](https://img.shields.io/npm/v/@chaos-maker/core)](https://www.npmjs.com/package/@chaos-maker/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Inject controlled chaos into web applications to test frontend resilience. Works with Playwright, Cypress, WebdriverIO, and Puppeteer with no backend changes.

## What's new in v0.6.0

- **Production-ready presets** for the scenarios you'd actually script: `mobile-3g`, `checkout-degraded`. Drop one into a config and run. [Preset catalog](https://chaos-maker-dev.github.io/chaos-maker/concepts/presets/).
- **Deterministic replay and visibility**: `formatSeedReproduction(seed)` reexported from every adapter, Cypress Command Log writes applied chaos events inline, and Playwright trace step coverage is rock solid. [Replay recipe](https://chaos-maker-dev.github.io/chaos-maker/recipes/reproduce-flaky-failure/).
- **Cleanup reliability hardening**: stop clears Service Worker seed and counters, cancels delayed WebSocket and EventSource deliveries, frees runtime handles, and fails fast on double-inject. Repeat inject/remove cycles and reused pages are now safe by construction.

Full release notes in [CHANGELOG.md](CHANGELOG.md).

## Install

```bash
npm install @chaos-maker/core @chaos-maker/playwright
npm install @chaos-maker/core @chaos-maker/cypress
npm install @chaos-maker/core @chaos-maker/webdriverio
npm install @chaos-maker/core @chaos-maker/puppeteer
```

## Quick start with presets

Drop a named scenario into the config - flaky backend, mobile network, checkout instability - and run. Layer multiple presets for compound scenarios.

```typescript
import { test, expect } from '@playwright/test';
import { injectChaos } from '@chaos-maker/playwright';

test('checkout works under degraded mobile network', async ({ page }) => {
  await injectChaos(page, { presets: ['mobile-3g', 'checkout-degraded'], seed: 42 });
  await page.goto('/checkout');
  await expect(page.locator('[data-testid="checkout-form"]')).toBeVisible();
});
```

See the full catalog in the [Presets docs](https://chaos-maker-dev.github.io/chaos-maker/concepts/presets/). When a failure only appears under a generated seed, follow the [replay recipe](https://chaos-maker-dev.github.io/chaos-maker/recipes/reproduce-flaky-failure/).

## Scenario profiles

When several tests should share the same named scenario, wrap it into a profile. Chaos Maker ships exactly one built-in `mobileCheckout` demo profile (a wiring proof, not an open catalog) - define your own scenarios via `customProfiles`. Pass `profileOverrides` alongside `profile` to tune one parameter at the call site without forking the profile.

```typescript
await injectChaos(page, {
  profile: 'mobile-checkout',
  profileOverrides: {
    network: { latencies: [{ urlPattern: '/api/extra', delayMs: 999, probability: 1 }] },
  },
  seed: 42,
});
```

See the [Scenario profiles concept](https://chaos-maker-dev.github.io/chaos-maker/concepts/profiles/) for the resolution rules and runtime override precedence.

## 30-second Playwright quickstart

When a preset is too coarse, drop down to explicit rules:

```bash
npm install @chaos-maker/core @chaos-maker/playwright
```

```typescript
import { test, expect } from '@playwright/test';
import { injectChaos, getChaosLog } from '@chaos-maker/playwright';

test('shows error state when payment API fails', async ({ page }) => {
  await injectChaos(page, {
    seed: 42,
    network: {
      failures: [{ urlPattern: '/api/payments', statusCode: 503, probability: 1.0 }],
    },
  });

  await page.goto('/checkout');
  await page.click('#pay-now');
  await expect(page.locator('[data-testid="error-banner"]')).toBeVisible();

  const log = await getChaosLog(page);
  expect(log.some(e => e.type === 'network:failure' && e.applied)).toBe(true);
});
```

## Adapter coverage

| Surface | Playwright | Cypress | WebdriverIO | Puppeteer |
| --- | --- | --- | --- | --- |
| Network fetch/XHR | Yes | Yes | Yes | Yes |
| UI assaults | Yes | Yes | Yes | Yes |
| WebSocket | Yes | Yes | Yes | Yes |
| Service Worker fetch | Yes | Yes | Yes | Yes |
| Server-Sent Events | Yes | Yes | Yes | Yes |
| GraphQL operation matcher | Yes | Yes | Yes | Yes |
| Rule Groups | Yes | Yes | Yes | Yes |

## Service Worker chaos

PWAs and offline-first apps serve fetches from a Service Worker. Those bypass page-side chaos, so add one line to your SW and chaos applies there too:

```js
// classic sw.js
importScripts('/chaos-maker-sw.js');
```

Page-side: `injectSWChaos` / `removeSWChaos` / `getSWChaosLog` in each adapter. See adapter READMEs.

## Rule Groups

Group related rules so a test can turn a whole failure scenario on or off at runtime without restarting chaos.

### Creating Groups

```ts
import { ChaosConfigBuilder } from '@chaos-maker/core';

const chaos = new ChaosConfigBuilder()
  .inGroup("payments")
  .failRequests("/api/pay", 503, 1)
  .build();
```

Rules without `.inGroup()` stay in the default group and continue to work as before.

### Runtime Toggle

The examples below use `page` as a generic adapter handle. See each adapter README for exact syntax.

```ts
await page.enableGroup("payments");
await page.disableGroup("payments");
```

Browser-side toggles affect rules injected into the page with `injectChaos`.

### Service Worker Toggle

```ts
await page.enableSWGroup("payments");
await page.disableSWGroup("payments");
```

Service Worker toggles affect rules injected into the active Service Worker with `injectSWChaos`. Browser-side and SW-side toggles are separate because they run in different JavaScript contexts. If a group has rules in both places, toggle both explicitly.

### Multiple Groups Example

```ts
import { ChaosConfigBuilder } from '@chaos-maker/core';

const chaos = new ChaosConfigBuilder()
  .inGroup("payments")
  .failRequests("/api/pay", 503, 1)
  .inGroup("auth")
  .failRequests("/api/session", 401, 1)
  .inGroup("analytics")
  .addLatency("/api/events", 750, 1)
  .build();

await injectChaos(page, chaos);

await page.disableGroup("payments");
await page.enableGroup("auth");
await page.enableGroup("analytics");
```

In this state, payment failures are skipped, auth failures run, and analytics latency runs.

### Troubleshooting

- Group not working: confirm the rule was created with `.inGroup("name")` or `group: "name"`, and confirm you awaited the toggle before triggering the request.
- Group name errors: group names must be strings after trimming. Empty strings, whitespace-only strings, and `null` throw.
- SW toggling issues: call `injectSWChaos` after the page has an active Service Worker controller, and use `enableSWGroup` or `disableSWGroup` for SW rules. Page-side `enableGroup` does not toggle SW rules.

## SSE and GraphQL

```typescript
await injectChaos(page, {
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
```

## Full docs

[Getting started](https://chaos-maker-dev.github.io/chaos-maker/getting-started/install) | [Concepts](https://chaos-maker-dev.github.io/chaos-maker/concepts/chaos-types) | [Recipes](https://chaos-maker-dev.github.io/chaos-maker/recipes/slow-checkout) | [API](https://chaos-maker-dev.github.io/chaos-maker/api/core)

## Development

```bash
pnpm install        # install all workspace dependencies
pnpm build          # build all packages
pnpm test           # unit tests
pnpm lint           # eslint
pnpm dev:docs                 # local docs dev server
pnpm build:docs               # build docs for production
```

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Run the full check before submitting:

```bash
pnpm lint && pnpm test && pnpm build
pnpm --filter e2e-tests-playwright exec playwright test --reporter=line --project=chromium
```

## License

[MIT](LICENSE)
