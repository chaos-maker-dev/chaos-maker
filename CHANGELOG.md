# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **Scenario profiles and runtime overrides**: new top-level fields on `ChaosConfig` - `profile?: string` selector, `profileOverrides?: ProfileOverrideSlice` runtime tweak slice, and `customProfiles?: Record<string, ProfileConfigSlice>` for inline scenario registration alongside the one built-in demo. The single built-in profile, `mobileCheckout` (with kebab alias `mobile-checkout`), composes `presets: ['mobile-3g', 'checkout-degraded']` as a wiring demo; profiles are intentionally user-owned beyond this entry. New per-instance `ProfileRegistry` class plus `BUILT_IN_PROFILES` constant and the pure-functional `applyProfile(config, registry)` resolver. New builder methods on `ChaosConfigBuilder`: `.useProfile(name)` (singular, replaces on second call), `.defineProfile(name, slice)` (fail-fast on duplicate), and `.overrideProfile(slice)` (accumulates across calls with append-merge on rule arrays plus last-write-wins on scalars). Runtime override precedence (highest wins): `profileOverrides.{seed,debug}` > top-level `{seed,debug}` > profile's own `{seed,debug}`; rule arrays append in profile -> top-level -> override order. Resolution runs inside `prepareChaosConfig` between Zod pass 1 and `expandPresets`, after which `profile`, `profileOverrides`, and `customProfiles` are stripped from the resolved config. New `RuleType: 'profile'` member plus `ValidationIssueCode` additions `unknown_profile`, `profile_collision`, and `profile_chain` (recursive profile inheritance stays out of scope and is rejected). Brand cache continues to short-circuit on opts-empty re-validation; new drift guard on `ProfileConfigSlice` keeps the strict slice schema in sync. All four framework adapters (`@chaos-maker/playwright`, `@chaos-maker/cypress`, `@chaos-maker/webdriverio`, `@chaos-maker/puppeteer`) re-export `Profile`, `ProfileConfigSlice`, and `ProfileOverrideSlice` for typed consumer code; the new fields flow through `injectChaos(page, config, opts)` unchanged. New E2E coverage: `profile-mobile-checkout` spec on Playwright, Cypress, Puppeteer, and WebdriverIO uses `{ profile: 'mobile-checkout' }` against the live fixture; Playwright additionally gets `profile-override` covering runtime override layering. Documentation: new `concepts/profiles.mdx` covers profiles versus presets, the built-in demo profile, custom profile registration, runtime overrides, precedence, the validation pipeline, builder chain, determinism, and mutability; getting-started pages and adapter pages gain `profile`-first snippets; root README and core API reference document the new surface.

## [0.6.0] - 2026-05-16

### Added

- **Production-ready presets**: two new built-in presets, `mobileThreeG` (alias `mobile-3g`) approximating 3G round-trip with 1500ms latency at 100% plus 2% aborts on every URL, and `checkoutDegraded` (alias `checkout-degraded`) scoping payment instability to `/checkout` and `/api/payments` with 30% latency at 800ms and occasional 503/500 responses. Three new kebab aliases for existing slices share object identity with their camelCase entries: `api-flaky` → `flakyConnection`, `websocket-instability` → `unreliableWebSocket`, `realtime-lag` → `unreliableEventStream`. The legacy `presets` record gains `mobileThreeG` and `checkoutDegraded`; aliases stay registry-only. New unit coverage for registry seeding (now 18 entries: 9 camelCase + 9 kebab), expansion of new presets, alias dedup, and builder round-trip. New E2E spec `preset-mobile-3g` on Playwright, Cypress, Puppeteer, and WebdriverIO using deterministic existence checks (fixed seed, no rate / tolerance assertions). Documentation: catalog rebuild in `concepts/presets.mdx` covers name, aliases, transports, intent, and suggested assertions; getting-started pages and the root README now lead with preset-first examples and keep explicit-rule examples as the lower-level alternative.
- **Deterministic replay and visibility**: new `formatSeedReproduction(seed)` helper in core with re-exports from Playwright, Cypress, Puppeteer, and WebdriverIO. Event formatting moved into core for adapter reuse while Playwright keeps its existing trace exports. Cypress support now writes applied chaos events to the Command Log with the same filter as Playwright trace steps. Playwright trace wiring now has unit coverage for idempotency, empty attachments, late-event safety, verbose filtering, and debug filtering. Documentation now includes a full event taxonomy, skipped-chaos troubleshooting, replay boundaries, two replay/debug recipes, seed-on-failure snippets, and Service Worker log accessor guidance across adapter READMEs.
- **Cleanup reliability hardening**: core cleanup now clears saved runtime handles after restore, cancels delayed WebSocket and EventSource deliveries on stop, resets Service Worker seed and counters on stop, emits debug-only diagnostics for double-patched globals, stale wrappers, and orphaned observers, and fails fast on active instance conflicts. Adapter cleanup now clears page-side and worker-side Service Worker logs, WebdriverIO cleanup is best-effort after session teardown, and local cleanup queues continue through every callback before reporting failures. New unit and E2E coverage covers repeated inject/remove cycles, reload isolation, Playwright page isolation, Service Worker stop/reinject on reused registrations, and closed page/session cleanup.

## [0.5.0] - 2026-05-09

### Added

- **Rule Validation**: new canonical entry point `validateChaosConfig(input, opts?)` layers schema-version gating, brand-cache short-circuit, deprecation walk, and custom per-`RuleType` validators on top of `prepareChaosConfig`. `ChaosConfigError.issues` is now `ValidationIssue[]` with structured `path` / `code` / `ruleType` / `message` / `expected` / `received`; legacy v0.4.x string array stays available via `error.messages`. Issues are deterministically sorted (path then code) and rendered with a 50-issue cap plus `... and N more` summary. Every adapter (`@chaos-maker/playwright`, `@chaos-maker/cypress`, `@chaos-maker/puppeteer`, `@chaos-maker/webdriverio`) validates the config before transport so malformed configs throw `ChaosConfigError` synchronously from Node, not from the browser console; `InjectChaosOptions.validation` and `SWChaosOptions.validation` plumb `unknownFields` / `onDeprecation` / `customValidators` through. New `unknownFields: 'reject' | 'warn' | 'ignore'` mode, strict-by-default; `'warn'` and `'ignore'` both strip unknowns from the returned config and `'warn'` emits exactly one aggregated `console.warn` per call. New `schemaVersion?: 1` reserved field rejects unknown values before Zod runs. Validated configs carry a non-enumerable `Symbol.for('chaos-maker.validated')` brand carrying `VALIDATOR_BRAND_VERSION = 1`; stale brands re-validate. Ships `@chaos-maker/core/dist/chaos-config.schema.json` (generated via `zod-to-json-schema`) plus the sidecar `chaos-config.schema.notes.md` listing JSON Schema parity caveats - JSON Schema is a tooling approximation; runtime canonical remains Zod. Two prebuilt schema variants (`chaosConfigSchemaStrict`, `chaosConfigSchemaPassthrough`) built once at module load - no per-call rebuild. Bidirectional `RULE_TYPE_TO_SCHEMA` drift guard mirrors the existing `_sliceSchemaCovers` pattern. Page-side SW `bridge.apply` rejects non-object payloads. Backward compatible: every v0.4.x config validates unchanged.
- **Presets**: per-instance `PresetRegistry` seeded with the seven built-ins plus four kebab-case aliases (`slow-api`, `flaky-api`, `offline-mode`, `high-latency`) sharing object identity with their camelCase entries. New declarative `presets: string[]` and `customPresets: Record<string, PresetConfigSlice>` fields on `ChaosConfig`, new fluent `ChaosConfigBuilder.usePreset(name)`, and the new canonical runtime entry point `prepareChaosConfig(input)` (validates, expands, re-validates). Adapter SW page-side helpers route through `prepareChaosConfig` so SW consumers get presets expanded too. Custom presets are validated against a strict slice schema - chained `presets`, `customPresets`, `seed`, or `debug` reject at construction with `ChaosConfigError`, as do unknown preset names, duplicate registrations, and group-name collisions across preset+user. Built-in preset configs are deep-frozen; custom preset literals stay mutable for the caller, deep-cloned at expansion. Append-only merge: preset rules first (in listed order), user rules last. New core unit tests cover the registry, expansion, builder helper, and constructor integration; legacy `presets` record export keeps its seven camelCase keys.
- **Debug Mode**: opt-in `debug: true` flag on `ChaosConfig` now produces a structured log of every rule decision plus a `[Chaos] <stage>: ...` mirror line on `console.debug`. Single new `type: 'debug'` event with `detail.stage` covering eight stages: `rule-evaluating`, `rule-matched`, `rule-skip-match`, `rule-skip-counting`, `rule-skip-group`, `rule-skip-probability`, `rule-applied`, `lifecycle`. Lifecycle phases cover `engine:start`, `engine:stop`, `engine:group-toggled`, plus `sw:config-applied`, `sw:config-stopped`, and `sw:group-toggled`. Positional `ruleId` (`<ruleType>#<index>`) and reserved `ruleName` make multi-rule configs self-diagnosing. Fast-path no-op when disabled. Framework-agnostic: never reads `PWDEBUG`, `--debug`, `DEBUG=cypress:*`, `DEBUG=puppeteer:*`, `DEBUG=wdio:*`, or `localStorage.debug`. New `withDebug(enabled?)` builder method. Playwright trace integration filters `type: 'debug'` events out of inline `test.step` entries while still landing them in the `chaos-log.json` attachment. New core unit tests (logger, emitter no-op fast path, performance behavioral assertion, lifecycle, validation, network decision pipeline). New E2E `debug-mode` spec on Playwright, Cypress, Puppeteer, and WebdriverIO.
- Rule Groups adapter coverage: Playwright, Puppeteer, WebdriverIO, and Cypress now have matching package-level tests for browser-side toggles, default-group behavior, multiple groups, Service Worker group toggles, invalid names, and adapter parity.
- Rule Groups documentation: the root README and adapter READMEs now cover creating groups, runtime toggles, Service Worker toggles, multiple-group examples, and troubleshooting.

## [0.4.0] - 2026-04-26

### Added

- **Service Worker chaos (Phase 1 of v0.4.0)**: chaos rules now apply to fetches issued from a service worker. New subpath export `@chaos-maker/core/sw` ships dual ESM (`sw.mjs`) + IIFE (`sw.js`) bundles excluding Zod, the UI assailant, and the builder. Users add one line to their service worker (`importScripts('/path/to/chaos-maker-sw.js')` for classic SWs, or `import { installChaosSW } from '@chaos-maker/core/sw'` for module SWs). New shared `SW_BRIDGE_SOURCE` constant + `injectSWChaos`, `removeSWChaos`, `getSWChaosLog`, and `getSWChaosLogFromSW` helpers in all 4 adapters. Auto-reapply on `controllerchange` so SW updates inherit config.
- **SSE / EventSource chaos (Phase 2 of v0.4.0)**: new `sse` config block on `ChaosConfig` with `drops`, `delays`, `corruptions`, and `closes`. Mirrors the WebSocket interceptor's wrapper-constructor approach to patch `globalThis.EventSource` - intercepts inbound `MessageEvent`s, supports per-rule `urlPattern`, `eventType` (named events or `'*'` wildcard), `probability`, `onNth`/`everyNth`/`afterN`, and the four standard corruption strategies (`truncate`, `malformed-json`, `empty`, `wrong-type`). New events `sse:drop`, `sse:delay`, `sse:corrupt`, `sse:close`. Builder shortcuts `dropSSE`, `delaySSE`, `corruptSSE`, `closeSSE`. New `unreliableEventStream` preset (5% drops + 200ms delay + 2% close-after-2s). Wildcard rules auto-attach a chaos listener whenever the app subscribes to a new named event type. SSE types re-exported from all 4 adapters; new E2E coverage on Playwright (chromium+firefox+webkit+edge), Cypress (chrome+electron), and Puppeteer.
- **GraphQL operation-name matching (Phase 3 of v0.4.0)**: every network rule (failures, latencies, aborts, corruptions, cors) now accepts an optional `graphqlOperation: string | RegExp` field. Acts as an AND filter on top of `urlPattern` + `methods` - a rule with `graphqlOperation: 'GetUser'` only fires for that operation, leaving every other operation on the same `/graphql` URL untouched. Detection covers both POST + JSON body (operation read from `operationName` field, then fallback to parsing `query GetUser { … }`) and persisted-query GET requests (`?operationName=` / `?query=`). Batched array bodies use the first entry. Anonymous operations don't match a non-null matcher. Multipart, ReadableStream, or binary bodies emit a diagnostic `applied: false, reason: 'graphql-body-unparseable'` event so users can debug why their rule isn't firing. New `operationName` field on event detail. Builder shortcuts `failGraphQLOperation(name, status, prob)` and `delayGraphQLOperation(name, ms, prob)`. Builder clone now preserves `RegExp` matchers across `.build()` calls. New `/graphql` fixture endpoint on port 8083 (with canned operations + persisted-query support); Playwright (7 specs × 4 browsers = 28), Cypress (6 specs), and Puppeteer (5 specs) E2E coverage. Fast path: when no rule sets `graphqlOperation`, the body extractor is skipped entirely so non-GraphQL apps pay zero cost.
- **Adapter parity + docs (Phase 4 of v0.4.0)**: WDIO now has runtime E2E coverage for SSE and GraphQL operation matching, including RegExp matcher transport, persisted GET, multipart diagnostics, anonymous-query skips, XHR GraphQL, named SSE events, and forced SSE closes. Docs now cover Service Worker chaos, SSE chaos, AI chat streaming under flaky SSE, and failing one GraphQL operation while others pass.

### Changed

- **`@chaos-maker/core` - `globalThis` refactor (Phase 0 of v0.4.0)**: interceptors read their targets (`fetch`, `XMLHttpRequest`, `WebSocket`) through `globalThis` instead of `window`, so the same engine code now runs in both browser page contexts and service worker / worker contexts. No public API change beyond a new optional `ChaosMaker(config, { target })` constructor argument that defaults to `globalThis`.
- UI-config (`config.ui`) is now skipped with a warning (instead of throwing) when no DOM is available in the current context. XHR and WebSocket patching likewise feature-detect before attaching. This is groundwork for v0.4.0 Phase 1 (Service Worker chaos) - no new surface is exposed yet.

## [0.3.0] - 2026-04-23

### Added

- **WebdriverIO adapter** (`@chaos-maker/webdriverio`): one-line injection via `injectChaos(browser, config)`, `getChaosLog(browser)`, `getChaosSeed(browser)`, `useChaos(browser, config)`. Embeds the UMD bundle in an injected script tag so Firefox geckodriver still sees the config during initial page load.
  - E2E suite: 49 tests across Chrome and Firefox covering resilience baseline, presets, network/WebSocket/UI chaos, seeded reproducibility, and Nth-request counting.
  - New CI jobs `e2e-webdriverio (chrome)` and `e2e-webdriverio (firefox)`.
- **Puppeteer adapter** (`@chaos-maker/puppeteer`): one-line injection via `injectChaos(page, config)`, `removeChaos(page)`, `getChaosLog(page)`, `getChaosSeed(page)`, `useChaos(page, config)`. Uses `page.evaluateOnNewDocument` to patch `fetch`, `XMLHttpRequest`, and `WebSocket` before any page script runs; tracks init-script identifiers in a `WeakMap<ChaosPage>` so `removeChaos` + repeat `injectChaos` tear down cleanly without stacking.
  - E2E suite: 37 tests on headless Chromium, mirroring the Playwright suite where applicable.
  - New CI job `e2e-puppeteer (headless-new)`.
- **Documentation site** (Starlight-powered, published to GitHub Pages at <https://chaos-maker-dev.github.io/chaos-maker/>): 28 pages covering Install, per-adapter Getting Started, Concepts (chaos types, presets, builder, seeded reproducibility, Nth counting, observability), eight Recipes, API reference, and a Rationale section. Search via Pagefind.
- **Seeded determinism enforcement**: `Math.random` is now an ESLint error across `packages/**` (via `no-restricted-syntax` AST rule, exempt only in `prng.ts`). Every chaos probability decision must flow through `createPrng(seed)` so replays are bit-exact.

### Changed

- `@chaos-maker/core` bumped to 0.3.0 - emits a bit-exact event log for a given seed; any accidental `Math.random` usage now fails CI.
- `@chaos-maker/playwright` bumped to 0.3.0 to pick up core 0.3.0.
- `@chaos-maker/cypress` bumped to 0.3.0 to pick up core 0.3.0.
- Release workflow: new adapters (`webdriverio`, `puppeteer`) publish via classic `NPM_TOKEN` on first release because npm Trusted Publishing requires a pre-existing package. Existing adapters (`core`, `playwright`, `cypress`) continue using OIDC Trusted Publishing.

### Fixed

- **Puppeteer re-injection**: `injectChaos` now removes the prior page's init scripts before registering new ones, preventing double-patching when pages are reused across test cases.
- **Docs site base path**: inline markdown links and hero actions on the Starlight site are now prefixed with `/chaos-maker/` so they resolve under the GitHub Pages base instead of 404ing.
- **Deterministic replay test**: reverted an ill-fitting event-based wait - chaos events are probabilistic so `waitForChaosLogGrowth` could hang when the rolled probability said "no chaos"; reverted to fixed `waitForTimeout` since the seeded PRNG already guarantees reproducibility.

### Security

- Upgraded Astro (4 → 6) and Starlight (0.21 → 0.38) in the docs workspace, clearing 19 transitive CVEs.
- Added `pnpm.overrides` for `diff`, `tar-fs`, `tmp`, `ws`, `serialize-javascript`, `fast-xml-parser` to patch 8 more transitive CVEs across the repo.
- One residual Dependabot alert (`uuid < 14.0.0` via `@cypress/request@3.0.10`) is accepted as tolerable: dev-only transitive, no patched version in range, exploit path (user-controlled `buf` into `v3/v5/v6`) not reachable from Cypress's usage.

## [0.2.0] - 2026-04-17

### Added

- **Playwright trace integration** (Phase 5): every applied chaos event now appears inline in the Playwright trace action timeline as a `chaos:<type>` `test.step` entry (e.g. `chaos:network:failure /api/users → 503`). Full event log + PRNG seed attached as `chaos-log.json` on test end.
  - New `InjectChaosOptions` on `injectChaos(page, config, opts)`: `{ tracing: boolean | 'auto', testInfo, traceOptions }`.
  - Fixture auto-enables tracing whenever the project's `use.trace !== 'off'`; opt out per-call with `chaos.inject(config, { tracing: false })`.
  - Bridging via `page.exposeBinding('__chaosMakerReport', …)` + an `addInitScript` subscriber on `chaosUtils.instance.on('*')`. Survives cross-navigation and idempotent per page.
  - New `packages/playwright/src/trace.ts` exports `formatStepTitle`, `shouldEmitStep`, `createTraceReporter`, `ChaosTraceAttachment`, `TraceReporterOptions`.
  - E2E coverage: `e2e-tests/playwright/tests/trace-integration.spec.ts` cracks open the produced `trace.zip` (all four projects: chromium, firefox, webkit, edge) and asserts chaos steps present.
  - Unit coverage: 13 formatter/filter tests under `packages/playwright/test/trace.test.ts`.
- **Cypress adapter coverage** (from rc.1): unchanged - Cypress surfaces chaos via `Cypress.log` (the Command Log), no trace-viewer work needed.

## [0.2.0-rc.1] - 2026-04-17

### Added

- **Cypress adapter** (`@chaos-maker/cypress`): one-line chaos injection via `cy.injectChaos(config)`, `cy.removeChaos()`, `cy.getChaosLog()` custom commands. Ships `@chaos-maker/cypress/support` (auto-registration of commands + `afterEach` cleanup) and `@chaos-maker/cypress/tasks` (plugin-process bridge that reads the UMD bundle from disk).
- **Cypress E2E suite**: 60 tests across 7 spec files in `e2e-tests/cypress/` - full parity with Playwright suite (resilience baseline, chaos lifecycle + presets, network, UI, WebSocket, seeded randomness, Nth-request counting). Runs against Chrome and Electron in CI.
- **CI job `e2e-cypress`**: matrix over `[chrome, electron]` with Cypress binary caching. Firefox is omitted because Cypress 13.x's CDP-over-GeckoDriver bridge is broken against Firefox 140+ (a Cypress-infrastructure issue, not a chaos-maker one); Playwright's `e2e-playwright (firefox)` job covers the Firefox browser engine end-to-end.
- **Release job `publish-cypress`**: publishes `@chaos-maker/cypress` to npm on tagged releases after `publish-core` succeeds.

### Changed

- **E2E layout restructured**: `e2e-tests/` now contains `e2e-tests/{framework}/` subdirectories (`playwright/`, `cypress/`) plus shared `e2e-tests/fixtures/`. Cypress layout flattened to `tests/` + `support/` (overriding Cypress defaults of `cypress/e2e/` + `cypress/support/`) for cross-framework directory symmetry.
- **Package filters renamed**: `e2e-tests` workspace package split into `e2e-tests-playwright` and `e2e-tests-cypress`. Root scripts renamed: `test:e2e` → `test:playwright` + `test:cypress`.
- **CI job renamed**: `e2e-test` → `e2e-playwright` (plus new sibling `e2e-cypress`).
- **Fixture ws-echo-server**: `.js` → `.cjs` to prevent Node treating it as ESM under the root `"type": "module"`.

## [0.2.0-beta.1] - 2026-04-16

### Added

- **WebSocket chaos**: intercept `window.WebSocket` to drop, delay, corrupt, or force-close messages and connections (inbound/outbound/both)
  - Config types: `WebSocketDropConfig`, `WebSocketDelayConfig`, `WebSocketCorruptConfig`, `WebSocketCloseConfig`
  - Corruption strategies: `truncate`, `malformed-json`, `empty`, `wrong-type` (JSON strategies emit `applied: false` with `reason: 'incompatible-payload-type'` for binary frames)
  - Ordering per message: drop → corrupt → delay; close chaos cancels pending per-socket timers so pending delays never fire after close
  - Wrapper preserves `instanceof WebSocket` via prototype aliasing so app code using `instanceof` keeps working
  - New `unreliableWebSocket` preset (10% drop both ways, 500ms inbound delay, 5% inbound truncate)
  - Builder: `.dropMessages()`, `.delayMessages()`, `.corruptMessages()`, `.closeConnection()` + `.dropMessagesOnNth()`, `.delayMessagesOnNth()` shortcuts
  - Emitted events: `websocket:drop`, `websocket:delay`, `websocket:corrupt`, `websocket:close` with `direction`, `payloadType`, `closeCode`, `closeReason`, and `reason` detail fields
- **Per-rule request counting** (Phase 2): `onNth`, `everyNth`, `afterN` on every network and websocket rule - deterministic "fail the 3rd request", "drop every other message"
- **Seeded randomness** (Phase 1): `seed` field on `ChaosConfig`, auto-generated if omitted, exposed via `getChaosSeed(page)` for reproducible chaos runs
- **Playwright adapter**: re-exports `WebSocketConfig`, `WebSocketDropConfig`, `WebSocketDelayConfig`, `WebSocketCorruptConfig`, `WebSocketCloseConfig`, `WebSocketDirection`, `WebSocketCorruptionStrategy`
- **E2E coverage**: WebSocket chaos E2E suite across chromium, firefox, webkit, edge (24 tests) - includes seeded replay determinism, per-message `onNth` counting, close-with-custom-code, truncation, relative-latency baseline

### Removed

- **Chrome extension**: Extracted from monorepo to keep focus on core library and framework adapters

## [0.1.0] - 2026-04-03

### Added

- **Network chaos**: failure injection, latency, connection abort, response corruption, CORS simulation
- **UI chaos**: disable, hide, or remove DOM elements by CSS selector via MutationObserver
- **Playwright adapter** (`@chaos-maker/playwright`): `injectChaos`, `removeChaos`, `getChaosLog`, test fixture
- **Config presets**: `unstableApi`, `slowNetwork`, `offlineMode`, `flakyConnection`, `degradedUi`
- **Fluent config builder**: `ChaosConfigBuilder` with chainable methods for all chaos types
- **Event observability**: typed events for every chaos check, wildcard listeners, bounded event log
- **Config validation**: Zod strict mode rejects unknown keys, descriptive error messages
- **CI pipeline**: GitHub Actions with lint, test, build, E2E across Chromium/Firefox/WebKit/Edge
- **Triple format output**: ESM + CJS + UMD for `@chaos-maker/core`
