# Chaos Maker

[![Build Status](https://github.com/chaos-maker-dev/chaos-maker/actions/workflows/ci.yml/badge.svg)](https://github.com/chaos-maker-dev/chaos-maker/actions)
[![npm](https://img.shields.io/npm/v/@chaos-maker/core)](https://www.npmjs.com/package/@chaos-maker/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Inject controlled chaos into web applications to test frontend resilience. Works with Playwright, Cypress, WebdriverIO, and Puppeteer with no backend changes.

## What's new in v0.9.0

- **Streaming chaos for `fetch(...).body`**: a new `fetchStream` config slice wraps every `Response.body` consumer so chunk-level chaos applies to AI chat SDKs (Vercel AI SDK, OpenAI SDK, LangChain, anything that reaches for `Response.body.getReader()`). Drop, delay, corrupt, duplicate, or truncate individual chunks by zero-based index or by probability. See [AI streaming concept](https://chaos-maker-dev.github.io/chaos-maker/concepts/ai-streaming/).
- **Per-chunk phase markers on SSE + WebSocket + fetch-stream**: every streaming event now carries `detail.phase` (`ai:first-chunk`, `ai:stream-paused`, `ai:stream-resumed`, `ai:stream-truncated`, `ai:chunk-duplicated`) and a stable `detail.connectionId`, so report consumers can reconstruct a chunk-level timeline without rerunning matchers.
- **`ai` config shorthand**: a single `ai: { firstChunkDelayMs, pauseAfterChunk, truncateAfterChunk, duplicateChunkProbability, transport }` block compiles into transport rule arrays at engine init so the same scenario fires across fetch-stream, SSE, and WebSocket without per-transport duplication. See the [AI chat fetch-stream recipe](https://chaos-maker-dev.github.io/chaos-maker/recipes/ai-chat-fetch-stream/) and [AI chat SSE recipe](https://chaos-maker-dev.github.io/chaos-maker/recipes/ai-chat-streaming-sse/).
- **`'duplicate'` corruption strategy on fetch-stream**: emission-level chunk duplication; consumers see the same chunk one additional time. Use for testing client-side idempotency under retry storms or replayed deltas.
- **Stream replay and mutation**: capture a stream to a versioned JSON fixture and replay it deterministically with no live backend, across fetch-stream, SSE, and WebSocket. Six chunk mutations (`delay`, `truncate`, `duplicate`, `split`, `coalesce`, `inject-malformed`) rewrite the stream by original chunk index with no RNG. New `loadStreamFixture` / `recordStreamFixture` adapter helpers. See the [stream replay concept](https://chaos-maker-dev.github.io/chaos-maker/concepts/stream-replay/).

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

For AI chat and assistant interfaces, six streaming presets reproduce the incidents those UIs hit in production: `ai-slow-first-chunk`, `ai-stream-paused`, `ai-stream-truncated`, `ai-tool-call-fails`, `ai-retry-loop`, and `ai-reconnect-after-drop`.

```typescript
await injectChaos(page, { presets: ['ai-slow-first-chunk'], seed: 42 });
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

## Advanced matchers

Every network, WebSocket, and SSE rule accepts hostname, query parameter, and (network-only) request header / resource-type matchers alongside `urlPattern` and `methods`. A separate `matchers` registry holds reusable named matchers so one matcher can target network, WebSocket, and SSE without per-transport duplication.

```typescript
await injectChaos(page, {
  matchers: {
    customers: {
      hostname: 'api.example.com',
      urlPattern: '/api/customers',
      methods: ['GET'],
      requestHeaders: { authorization: /^Bearer / },
    },
  },
  network: {
    failures: [{ matcher: 'customers', statusCode: 503, probability: 1 }],
    latencies: [{ matcher: 'customers', delayMs: 500, probability: 1 }],
  },
});
```

See the [Advanced matchers concept](https://chaos-maker-dev.github.io/chaos-maker/concepts/matchers/) for the full surface, the four validation issue codes (`matcher_not_found`, `matcher_collision`, `matcher_inline_conflict`, `matcher_cycle`), and the matcher attribution on debug events.

### Built-in matchers

Three matchers ship built in, so the most common targets need no `matchers` entry:

```typescript
await injectChaos(page, {
  network: {
    latencies: [{ matcher: 'graphql', delayMs: 1200, probability: 1 }],
  },
});
```

`graphql` (`/graphql`), `apiRequests` (`/api`), and `authRequests` (any request with an `Authorization` header) resolve by name and behave exactly like a matcher you define. A `matchers` entry of the same name overrides one. `authRequests` is meaningful for network rules only: it matches on a request header, which WebSocket and SSE rules cannot target, so a stream rule referencing it matches every connection.

## Reporting and timeline

After a chaos run, turn the event log into a structured `ChaosReport` and serialize it as JSON, Markdown, or a self-contained HTML timeline. The core package returns strings; your test writes them to disk or attaches them as CI artifacts.

```typescript
import { test } from '@playwright/test';
import {
  buildChaosReport,
  formatReportHtml,
  getChaosLog,
  getChaosSeed,
  injectChaos,
} from '@chaos-maker/playwright';

test('attach a chaos report on every run', async ({ page }, testInfo) => {
  await injectChaos(page, { debug: true, network: { failures: [/* … */] }, seed: 42 });
  // run scenario …

  const events = await getChaosLog(page);
  const seed = await getChaosSeed(page);
  const report = buildChaosReport(events, { seed, title: testInfo.title });
  await testInfo.attach('chaos-report.html', {
    body: formatReportHtml(report),
    contentType: 'text/html',
  });
});
```

The HTML output is fully self-contained (inline CSS, no `<script>`, no external URLs). For PR comments, swap `formatReportHtml` for `formatReportMarkdown`. See the [Timeline and reporting concept](https://chaos-maker-dev.github.io/chaos-maker/concepts/timeline-and-reporting/) for the full report shape, determinism guarantees, and per-rule attribution requirements.

Streaming runs additionally produce per-connection lifecycle timelines (first-chunk latency, pauses and whether they resolved, truncation and replay markers with mutation attribution) plus a `streamingReadiness` scorecard that counts how many streamed connections completed without interruption. Reports for non-streaming runs are unchanged.

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

## Streaming chaos (AI chat, live captions, tickers)

Streaming UIs read responses chunk by chunk (`fetch(...).body.getReader()`,
`EventSource`, `WebSocket.onmessage`). The `fetchStream` slice wraps every
`Response.body` so chunk-level chaos applies to AI SDKs that read the stream
through the SDK rather than the user's `Response`. The `ai` shorthand
compiles into the matching transport rules for fetch-stream, SSE, AND
WebSocket so one scenario covers whichever transport the SDK picked.

```typescript
await injectChaos(page, {
  ai: {
    firstChunkDelayMs: 800,
    pauseAfterChunk: 4,
    pauseDurationMs: 2000,
    truncateAfterChunk: 12,
    duplicateChunkProbability: 0.05,
    transport: 'auto', // 'fetch-stream' | 'sse' | 'websocket' | 'auto' (default)
  },
});
```

Every emitted streaming event carries `detail.phase` (`ai:first-chunk`,
`ai:stream-paused`, `ai:stream-resumed`, `ai:stream-truncated`,
`ai:chunk-duplicated`) and a stable `detail.connectionId`, so report
consumers can reconstruct a chunk-level timeline. See the [AI streaming
concept](https://chaos-maker-dev.github.io/chaos-maker/concepts/ai-streaming/)
and the recipes for [fetch-stream](https://chaos-maker-dev.github.io/chaos-maker/recipes/ai-chat-fetch-stream/)
and [SSE](https://chaos-maker-dev.github.io/chaos-maker/recipes/ai-chat-streaming-sse/).

### Replay captured streams

Capture a stream to a plain JSON fixture and replay it deterministically with
no live backend, then mutate chunks to reproduce broken responses. Load a
fixture on the Node side with `loadStreamFixture` (Playwright, Puppeteer,
WebdriverIO; Cypress uses `cy.readFile`) and pass it to `ai.replay`:

```typescript
import { injectChaos, loadStreamFixture } from '@chaos-maker/playwright';

await injectChaos(page, {
  ai: {
    replay: {
      data: loadStreamFixture('fixtures/chat-stream.json'),
      mutations: [
        { type: 'split', chunkIndex: 7, at: 32 },   // break a chunk in two
        { type: 'truncate', afterChunk: 12 },        // cut the stream short
      ],
    },
  },
});
```

Replay works across fetch-stream (block or substitute mode), SSE, and
WebSocket, and is fully deterministic (no RNG). See the [stream replay
concept](https://chaos-maker-dev.github.io/chaos-maker/concepts/stream-replay/)
and the [broken-markdown recipe](https://chaos-maker-dev.github.io/chaos-maker/recipes/replay-broken-markdown/).

## Full docs

[Getting started](https://chaos-maker-dev.github.io/chaos-maker/getting-started/install) | [Concepts](https://chaos-maker-dev.github.io/chaos-maker/concepts/chaos-types) | [Recipes](https://chaos-maker-dev.github.io/chaos-maker/recipes/slow-checkout) | [API](https://chaos-maker-dev.github.io/chaos-maker/api/core)

## Development

```bash
bun install        # install all workspace dependencies
bun run build      # build all packages
bun run test       # unit tests
bun run lint       # eslint
bun run dev:docs   # local docs dev server
bun run build:docs # build docs for production
```

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Run the full check before submitting:

```bash
bun run lint && bun run test && bun run build
bun run test:playwright -- --project=chromium
```

## License

[MIT](LICENSE)
