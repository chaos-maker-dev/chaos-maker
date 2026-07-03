# @chaos-maker/core

Core chaos engine for web applications. Intercepts `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, DOM mutations, and Service Worker fetches to inject controlled failures, latency, aborts, corruption, drops, closes, and UI disruptions.

Framework-agnostic. Works with Playwright, Cypress, Selenium, or any browser environment.

## Install

```bash
npm install @chaos-maker/core
```

## Usage

### Programmatic (ESM/CJS)

```ts
import { ChaosMaker } from '@chaos-maker/core';

const chaos = new ChaosMaker({
  network: {
    failures: [{ urlPattern: '/api', statusCode: 503, probability: 0.5 }],
    latencies: [{ urlPattern: '/api', delayMs: 2000, probability: 0.3 }]
  }
});

chaos.start();
// All matching fetch/XHR calls are now intercepted

chaos.on('network:failure', (event) => {
  console.log(`${event.detail.url} → ${event.applied ? 'failed' : 'passed'}`);
});

chaos.stop(); // restores original fetch/XHR
```

### Browser (UMD)

```html
<script src="chaos-maker.umd.js"></script>
<script>
  window.chaosUtils.start({
    network: {
      failures: [{ urlPattern: '/api', statusCode: 500, probability: 1.0 }]
    }
  });
</script>
```

### Presets

Presets are reusable bundles of rules. Drop them into a config by name with the `presets` field, and the engine merges them at construction time.

```ts
import { ChaosMaker } from '@chaos-maker/core';

const chaos = new ChaosMaker({
  presets: ['slow-api'],
  network: {
    failures: [{ urlPattern: '/api/checkout', statusCode: 500, probability: 1 }],
  },
});
chaos.start();
```

**Built-in catalog**

| camelCase name          | Kebab alias     | Behavior                                                          |
| ----------------------- | --------------- | ----------------------------------------------------------------- |
| `slowNetwork`           | `slow-api`      | 2000ms latency on every request                                   |
| `flakyConnection`       | `flaky-api`     | 5% aborts plus 3000ms latency on 10% of requests                  |
| `offlineMode`           | `offline-mode`  | Force CORS failure on every request                               |
| `unstableApi`           | `high-latency`  | 10% failures + 20% 1000ms latency, scoped to `/api/`              |
| `degradedUi`            |                 | 20% disable buttons, 10% hide links                               |
| `unreliableWebSocket`   |                 | 10% drops, 500ms inbound delay, 5% inbound truncation             |
| `unreliableEventStream` |                 | 5% drops, 200ms delay, 2% close after 2000ms                      |

Kebab-case aliases (`slow-api`, `flaky-api`, `offline-mode`, `high-latency`) are registry-only. They resolve via `presets: ['slow-api']` and `new PresetRegistry().get('slow-api')`. They are NOT keys on the legacy `presets` record export - `presets['slow-api']` is `undefined` by design. Use the camelCase key (`presets.slowNetwork`) when reading from the record.

**Custom presets**

Register your own bundle inline via `customPresets`. Names collide fail-fast against built-ins and against each other.

```ts
new ChaosMaker({
  customPresets: {
    'team-flow': {
      network: {
        failures: [{ urlPattern: '/checkout', statusCode: 503, probability: 1 }],
      },
    },
  },
  presets: ['team-flow'],
});
```

Custom preset values may carry only rule arrays plus the optional `groups` field - `presets`, `customPresets`, `seed`, and `debug` are rejected at validation. Dependency chains are out of scope.

**Builder helper**

```ts
import { ChaosConfigBuilder } from '@chaos-maker/core';

const config = new ChaosConfigBuilder()
  .usePreset('slow-api')
  .failRequests('/api/checkout', 500, 1)
  .build();
```

**Validation**

Unknown preset names, chain attempts, forbidden subfields, duplicate registrations, and group-name collisions across preset+user all surface as `ChaosConfigError` at construction time, never at runtime.

**Mutability**

Built-in preset configs are deep-frozen - `presets.slowNetwork.network!.latencies![0].delayMs = 1` throws. Your own custom presets passed via `customPresets` are NOT frozen - keep treating them as your data. The engine takes a deep clone at expansion, so any tweaks you make after construction are not observed.

**Legacy spread**

```ts
import { presets } from '@chaos-maker/core';

new ChaosMaker({ ...presets.slowNetwork, network: { failures: [{ urlPattern: '/api', statusCode: 500, probability: 1 }] } });
```

Still supported for migration. Prefer the declarative `presets:` field for new code.

### Config Builder

```ts
import { ChaosConfigBuilder } from '@chaos-maker/core';

const config = new ChaosConfigBuilder()
  .failRequests('/api/checkout', 500, 0.5)
  .addLatency('/api/', 2000, 0.3)
  .abortRequests('/api/upload', 1.0, 5000)
  .corruptResponses('/api/data', 'malformed-json', 0.2)
  .simulateCors('/external-api/', 1.0)
  .assaultUi('button.submit', 'disable', 0.1)
  .build();
```

## Chaos Types

| Type | Config Key | Description |
|------|-----------|-------------|
| Failure | `network.failures` | Force HTTP error responses |
| Latency | `network.latencies` | Add delays to requests |
| Abort | `network.aborts` | Cancel requests (immediate or timed) |
| Corruption | `network.corruptions` | Corrupt response bodies |
| CORS | `network.cors` | Simulate CORS errors |
| UI Assault | `ui.assaults` | Disable, hide, or remove DOM elements |
| WebSocket | `websocket.*` | Drop, delay, corrupt, or close socket messages |
| SSE | `sse.*` | Drop, delay, corrupt, or close EventSource events |
| Fetch stream | `fetchStream.*` | Drop, delay, corrupt, duplicate, or truncate `Response.body` chunks |
| AI shorthand | `ai` | One block compiling into fetch-stream + SSE + WebSocket streaming rules |
| Stream replay | `ai.replay` / `<transport>.replay` | Replay a captured stream fixture deterministically, with chunk mutations |
| User interaction | `userInteraction` | Cancel mid-stream, retry storms, tab-hidden, prompt edits, navigate-away |
| GraphQL | `graphqlOperation` | Target one operation on a shared endpoint |

## Matchers

Every network, WebSocket, and SSE rule accepts targeting matchers alongside `urlPattern` and `methods`:

- `hostname` (string or RegExp, case-insensitive on strings)
- `queryParams` (record of `string | RegExp | boolean`)
- `requestHeaders` (network only; case-insensitive keys)
- `resourceTypes` (network only; `['fetch' | 'xhr']`)

A top-level `matchers` registry holds reusable named matchers so one matcher can target network, WebSocket, and SSE without per-transport duplication:

```ts
new ChaosMaker({
  matchers: {
    customers: { hostname: 'api.example.com', urlPattern: '/api/customers' },
  },
  network: {
    failures: [{ matcher: 'customers', statusCode: 503, probability: 1 }],
  },
});
```

A rule supplies either inline matcher fields OR `matcher: 'name'`, never both. Mixing surfaces `matcher_inline_conflict` at validation time.

### Built-in matchers

Three matchers ship preregistered and resolve by name without any `matchers` entry:

- `graphql` (`urlPattern: '/graphql'`)
- `apiRequests` (`urlPattern: '/api'`)
- `authRequests` (`requestHeaders: { authorization: true }`)

```ts
new ChaosMaker({
  network: {
    latencies: [{ matcher: 'graphql', delayMs: 1200, probability: 1 }],
  },
});
```

`BUILT_IN_MATCHERS` is exported from `@chaos-maker/core` and every adapter. A user `matchers` entry of the same name transparently overrides a built-in. `authRequests` is meaningful on network rules only - WebSocket and SSE rules cannot target request headers, so a stream rule referencing it matches every connection.

See the [Matchers concept](https://chaos-maker-dev.github.io/chaos-maker/concepts/matchers/) for the full surface, validation codes, and debug attribution.

## Streaming and human-interaction chaos

Streaming UIs (AI chat, live captions, tickers) get chunk-level chaos across three transports plus the human side of streaming failures:

```ts
new ChaosMaker({
  // One block compiles into fetch-stream + SSE + WebSocket rules.
  ai: { firstChunkDelayMs: 800, truncateAfterChunk: 12 },
  // The user acts mid-generation, on a fixed deterministic schedule.
  userInteraction: {
    cancelStreamAfterMs: 4000,
    tabHidden: { afterMs: 1000, durationMs: 3000 },
    retryStorm: { count: 5, intervalMs: 200 },
  },
});
```

Streaming transport events carry `detail.phase` (`ai:first-chunk`, ...), a stable `detail.connectionId`, and a zero-based `detail.chunkIndex`. Human-interaction events (`ui:user-cancel`, `ui:retry-storm`, ...) carry `detail.phase` (`user:cancel`, ...), an optional `detail.connectionId`, and `detail.targetTransport`; they have no chunk index because they act on the connection, not a chunk. `buildChaosReport` groups both into per-connection timelines with a streaming-readiness scorecard. Captured stream fixtures replay deterministically via `ai.replay` with six chunk mutations. See the [AI streaming](https://chaos-maker-dev.github.io/chaos-maker/concepts/ai-streaming/), [stream replay](https://chaos-maker-dev.github.io/chaos-maker/concepts/stream-replay/), and [human interaction](https://chaos-maker-dev.github.io/chaos-maker/concepts/human-interaction-chaos/) concepts.

## Configuration Reference

### NetworkFailureConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `urlPattern` | `string` | Yes | Substring match against request URL |
| `statusCode` | `number` | Yes | HTTP status code (100-599) |
| `probability` | `number` | Yes | 0.0-1.0 chance of applying |
| `methods` | `string[]` | No | HTTP methods to match (default: all) |
| `graphqlOperation` | `string \| RegExp` | No | Operation name matcher for GraphQL requests |
| `body` | `string` | No | Custom response body |
| `statusText` | `string` | No | Custom status text |
| `headers` | `Record<string, string>` | No | Custom response headers |

### NetworkLatencyConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `urlPattern` | `string` | Yes | Substring match against request URL |
| `delayMs` | `number` | Yes | Delay in milliseconds |
| `probability` | `number` | Yes | 0.0-1.0 chance of applying |
| `methods` | `string[]` | No | HTTP methods to match |
| `graphqlOperation` | `string \| RegExp` | No | Operation name matcher for GraphQL requests |

### NetworkAbortConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `urlPattern` | `string` | Yes | Substring match against request URL |
| `probability` | `number` | Yes | 0.0-1.0 chance of applying |
| `timeout` | `number` | No | ms before abort (0 or omitted = immediate) |
| `methods` | `string[]` | No | HTTP methods to match |
| `graphqlOperation` | `string \| RegExp` | No | Operation name matcher for GraphQL requests |

### NetworkCorruptionConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `urlPattern` | `string` | Yes | Substring match against request URL |
| `strategy` | `CorruptionStrategy` | Yes | `'truncate'` \| `'malformed-json'` \| `'empty'` \| `'wrong-type'` |
| `probability` | `number` | Yes | 0.0-1.0 chance of applying |
| `methods` | `string[]` | No | HTTP methods to match |
| `graphqlOperation` | `string \| RegExp` | No | Operation name matcher for GraphQL requests |

### NetworkCorsConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `urlPattern` | `string` | Yes | Substring match against request URL |
| `probability` | `number` | Yes | 0.0-1.0 chance of applying |
| `methods` | `string[]` | No | HTTP methods to match |
| `graphqlOperation` | `string \| RegExp` | No | Operation name matcher for GraphQL requests |

### UiAssaultConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `selector` | `string` | Yes | CSS selector |
| `action` | `string` | Yes | `'disable'` \| `'hide'` \| `'remove'` |
| `probability` | `number` | Yes | 0.0-1.0 chance of applying |

### SSEConfig

```ts
sse: {
  drops: [{ urlPattern: '/events', eventType: 'token', probability: 0.1 }],
  delays: [{ urlPattern: '/events', delayMs: 500, probability: 1 }],
  corruptions: [{ urlPattern: '/events', strategy: 'truncate', probability: 0.05 }],
  closes: [{ urlPattern: '/events', afterMs: 2000, probability: 0.02 }],
}
```

`eventType` defaults to `message`; use a named event or `'*'` for all data events.

### GraphQL operation matching

```ts
network: {
  failures: [{
    urlPattern: '/graphql',
    graphqlOperation: 'GetUser',
    statusCode: 503,
    probability: 1,
  }],
}
```

`graphqlOperation` is an additional matcher on top of `urlPattern` and `methods`.

## Event System

```ts
chaos.on('network:failure', (event) => { /* ... */ });
chaos.on('*', (event) => { /* all events */ });
chaos.off('network:failure', listener);

const log = chaos.getLog();   // all events since start
chaos.clearLog();
```

Event types: `network:failure`, `network:latency`, `network:abort`, `network:corruption`, `network:cors`, `ui:assault`, `websocket:drop`, `websocket:delay`, `websocket:corrupt`, `websocket:close`, `sse:drop`, `sse:delay`, `sse:corrupt`, `sse:close`

## Config Validation

All configs are validated with Zod in strict mode. Unknown keys are rejected by default. Invalid values throw `ChaosConfigError` whose `issues` is a `ValidationIssue[]` with structured `path` / `code` / `ruleType` / `message` / `expected` / `received`.

```ts
import { validateChaosConfig, ChaosConfigError } from '@chaos-maker/core';

try {
  validateChaosConfig({
    network: { failures: [{ urlPattern: '', statusCode: 999, probability: 2 }] },
  });
} catch (e) {
  if (e instanceof ChaosConfigError) {
    for (const issue of e.issues) {
      console.log(issue.path, issue.code, issue.message);
    }
    // legacy v0.4.x string array still available:
    console.log(e.messages);
  }
}
```

`validateChaosConfig(input, opts?)` accepts:

- `unknownFields: 'reject' | 'warn' | 'ignore'` - strict by default. `'warn'` and `'ignore'` strip unknowns from the returned config; `'warn'` emits exactly one aggregated `console.warn` per call.
- `customValidators: Partial<Record<RuleType, (rule, ctx) => ValidationIssue[] | void>>` - run extra checks per rule type.
- `onDeprecation: (issue) => void` - receive `ValidationIssue` events for deprecated fields. The registry is empty for this release.

A JSON Schema artifact ships at `node_modules/@chaos-maker/core/dist/chaos-config.schema.json` for IDE / `"$schema"` autocomplete plus a sidecar `chaos-config.schema.notes.md` listing parity caveats. The artifact is a tooling approximation - runtime canonical validation is always Zod via `validateChaosConfig`.

See the [Rule Validation concept page](https://chaos-maker-dev.github.io/chaos-maker/concepts/validation/) for the full pipeline, brand semantics, and migration notes.

## Lifecycle and isolation

`start()` and `stop()` are the only entry points to the patched runtime. On `stop()` each restore step - `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and the DOM observer - runs inside its own `try` / `catch`, so one failing step does not block the others from running. The failing step is reported via a `cleanup-step-failed:<step>` debug event and a `console.warn`. Some edge cases (frozen prototypes, third-party code that re-wraps a global between `start()` and `stop()`, host objects that reject property writes) may still leave a global patched; treat the diagnostics surface as the source of truth rather than assuming an absolute restore guarantee.

```ts
const chaos = new ChaosMaker(config);
chaos.start();
try {
  // ... drive the page ...
} finally {
  chaos.stop(); // safe to call twice; idempotent.
}
```

Concurrent instances against the same target are rejected. A second `start()` on a target that already has an active instance throws `[chaos-maker] target already has an active runtime instance` so the first instance keeps owning the patched globals. Use one `ChaosMaker` per realm (page, worker, jsdom) and call `stop()` before constructing a replacement.

## Leak diagnostics

When debug mode is enabled, the engine emits structured invariant events whenever it sees signs of a leaked runtime - patched globals on start, stale wrapper handles, or another instance owning the target.

```ts
const chaos = new ChaosMaker(config, { debug: true });
chaos.start();
// ...
chaos.stop();

const issues = chaos.getLog().filter((event) =>
  event.type === 'debug' &&
  (event.detail.reason?.includes('already-patched') ||
   event.detail.reason?.includes('stale') ||
   event.detail.reason?.includes('orphaned') ||
   event.detail.reason === 'active-instance-conflict'),
);
```

Reasons emitted include `target-fetch-already-patched`, `target-xhr-open-already-patched`, `target-xhr-send-already-patched`, `target-websocket-already-patched`, `target-eventsource-already-patched`, `stale-websocket-handle`, `stale-eventsource-handle`, `orphaned-dom-observer`, `active-instance-conflict`, and `cleanup-step-failed:<step>`. The same reasons appear with `phase: 'engine:stop'` when a global stays patched after `stop()` runs.

Diagnostics are surfaced through `getLog()` only when `debug: true`; the runtime never throws on these conditions (the active-instance check is the one exception). They are intended for CI noise reduction and bug reports, not control flow.

## Service Worker chaos

Chaos applies to SW-originated fetches via the `@chaos-maker/core/sw` subpath. Zod + UI + builder are excluded from this bundle so it stays small enough for production SW deploys.

Classic SW (one line):

```js
// user's sw.js
importScripts('/path/to/chaos-maker-sw.js'); // auto-installs
```

Module SW:

```js
import { installChaosSW } from '@chaos-maker/core/sw';
installChaosSW({ source: 'message' });
```

Page-side config is delivered via `postMessage` + `MessageChannel` ack. Use the adapter helpers (`injectSWChaos` / `removeSWChaos` / `getSWChaosLog`) in `@chaos-maker/{playwright,cypress,webdriverio,puppeteer}`.

Limitations: `caches.match` hits bypass chaos; push/sync events not covered; cross-origin SWs not supported.

## License

[MIT](../../LICENSE)
