# Contributing to Chaos Maker

Thanks for your interest in contributing. This guide gets you from fork to merged PR.

## Getting Started

1. Fork the repository on GitHub.
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/chaos-maker.git
   cd chaos-maker
   ```
3. Install dependencies (Bun):
   ```bash
   bun install
   ```
4. Create a feature branch off `main`:
   ```bash
   git checkout -b feat/your-feature
   ```

## Project structure

```text
packages/
  core/              # @chaos-maker/core, the framework-agnostic chaos engine (Vite for ESM/CJS/UMD, Bun build for SW)
  playwright/        # @chaos-maker/playwright adapter (Bun build)
  cypress/           # @chaos-maker/cypress adapter (Bun build)
  webdriverio/       # @chaos-maker/webdriverio adapter (Bun build)
  puppeteer/         # @chaos-maker/puppeteer adapter (Bun build)

e2e-tests/
  fixtures/          # Shared HTTP / WS / SSE / GraphQL fixture servers, SW app
  playwright/        # e2e-tests-playwright workspace, Playwright specs
  cypress/           # e2e-tests-cypress workspace, Cypress specs
  webdriverio/       # e2e-tests-webdriverio workspace, WDIO specs
  puppeteer/         # e2e-tests-puppeteer workspace, Vitest + Puppeteer specs

docs/
  content-source/    # Source of truth for the docs site (Astro + Starlight)
  scripts/           # Versioned-docs generator driven by git tags
  src/               # Astro site + generated /v0-X-Y/ snapshots (do not hand-edit /src/content/docs)

scripts/             # Repo-wide build helpers (e.g. sync-sw-fixtures.mjs)
```

Adapter package names match their leaf directory in `packages/`. E2E workspace names use the `e2e-tests-<framework>` form so root scripts can target them with Bun filters.

## Development

All commands are run from the repo root.

```bash
bun install              # install all workspace dependencies
bun run lint             # ESLint across packages, adapters, e2e tests, and scripts
bun run test             # core unit suite (Vitest)
bun run build            # build all 5 published packages + sync the SW bundle into fixtures
bun run dev:core         # watch-build @chaos-maker/core
bun run dev:docs         # local docs dev server (Astro/Starlight)
bun run build:docs       # production docs build
```

### Running E2E tests locally

Each adapter has its own workspace and root script. They all consume the dist artifacts produced by `bun run build`, so build first if you have changed core or an adapter.

```bash
bun run test:playwright                              # all Playwright projects (chromium, firefox, webkit, edge)
bun run test:playwright -- --project=chromium        # single project, fastest iteration

bun run test:cypress                                 # default browser (chrome)
bun run test:cypress:chrome
bun run test:cypress:electron
bun run test:cypress:all                             # chrome + electron sequentially

bun run test:wdio                                    # chrome by default
bun run test:wdio:chrome
bun run test:wdio:firefox

bun run test:puppeteer                               # headless-new Chrome via Vitest
```

First run for Playwright requires browser installation (using `bunx playwright install` inside `e2e-tests/playwright`). Cypress installs its binary on first install. WebdriverIO uses your system Chrome / Firefox.

### Docs site

The Starlight docs site source lives in `docs/content-source/`. Edits there are picked up by `bun run dev:docs` immediately.

Versioned snapshots in `docs/src/content/docs/{latest,v0-X-Y}/` are **generated artifacts** produced by `docs/scripts/build-versioned-docs.mjs` from git tags. Do not hand-edit them; if you need to change copy that appears on the redirect landing page or in archived versions, edit the script's template literals (around the `index.mdx` writer) and regenerate.

The published site at <https://chaos-maker-dev.github.io/chaos-maker/> is rebuilt from tags only - PR docs builds run with `--dev` so contributors can preview unreleased content under `/main/`.

## CI

CI is split into three workflows under `.github/workflows/`:

- `ci.yml` runs on every push / PR to `main`. Lint + unit tests + build + per-adapter E2E matrix. The `ci-success` aggregator is the single required check for branch protection.
- `docs.yml` builds and deploys the versioned docs site on tag pushes.
- `release.yml` runs on `v*` tag pushes. Re-validates, then publishes all 5 packages to npm via OIDC Trusted Publishing.

Every job in `ci.yml` runs on `ubuntu-latest`. Browser binaries are restored from `actions/cache` keyed on the relevant workspace `package.json` (Playwright) or on `bun.lock` (Cypress, Puppeteer); on a cache miss the workflow installs them via `bunx playwright install --with-deps <project>`, `bunx cypress install`, and `bunx puppeteer browsers install chrome` respectively. WebdriverIO uses the system Chrome / Firefox provided by the runner image. There are no `container:` blocks to maintain, so a Playwright or Cypress dependency bump only needs the workspace `package.json` update.

## Adding a new chaos type

A new chaos type touches every layer of the stack. Follow this order:

1. `packages/core/src/config.ts` - add the rule's shape to `ChaosConfig` and the matching slice schema in `packages/core/src/validation.ts` (Zod).
2. `packages/core/src/interceptors/` - add or extend the interceptor that runs the rule. Route every probability decision through `createPrng(seed)` (Math.random is an ESLint error in `packages/**`).
3. `packages/core/src/builder.ts` - add fluent builder shortcuts so users do not have to hand-write rule objects.
4. `packages/core/test/` - add unit tests covering rule evaluation, counting predicates (`onNth` / `everyNth` / `afterN`), and group gating.
5. Add a preset to `packages/core/src/presets.ts` if the new chaos type composes naturally with existing ones.
6. Re-export new public types from each adapter's `src/index.ts` (`playwright`, `cypress`, `webdriverio`, `puppeteer`).
7. Add an E2E spec in **every** adapter under `e2e-tests/<framework>/tests/`. Unit coverage alone is not enough - real browser behavior is the gate.
8. Update docs: `docs/content-source/concepts/`, `docs/content-source/api/`, and any relevant getting-started example.
9. Update `CHANGELOG.md` under `[Unreleased]`. Use the same scope conventions as existing entries.

## Matcher parity tests

Matcher behavior is exercised by a shared declarative catalog at
`e2e-tests/fixtures/parity/` instead of per-adapter spec duplicates. The
catalog is the single source of truth: each scenario is a `{ id, title,
transport, config, steps, check }` value where `steps` is an ordered list of
generic actions (`click`, `waitForText`, `waitForCount`, `expectText`,
`request`, `settle`) and `check` is a pure assertion over the chaos log plus
any response statuses recorded by `request` steps. Every adapter has a thin
`_parity-runner.ts` interpreter that maps the generic steps onto its own
primitives, plus a one-file `matchers-parity.<spec|cy|test>.ts` that loops
the catalog.

When adding or changing a matcher behavior:

1. Add one scenario to the appropriate group file (`network.ts`,
   `built-in.ts`, `websocket.ts`, `sse.ts`) and re-export it through
   `catalog.ts`. The new title appears on all four adapters automatically.
2. Keep scenarios deterministic: pin `seed`, use `probability: 1` or `0`,
   and prefer same-origin requests so the response is fully readable. For
   negative network cases, vary the matcher's rule (for example, an
   unreachable `hostname` value) rather than the request URL.
3. Run each adapter's parity spec locally to confirm the new scenario
   passes identically on Playwright, Cypress, WebdriverIO, and Puppeteer.

Step 7 of "Adding a new chaos type" above still applies for new chaos types
that are not matcher-related: each chaos type ships with its own per-adapter
E2E spec because chaos-type semantics often diverge per browser API.

## Before submitting

```bash
bun run lint && bun run test && bun run build && bun run build:docs
bun run test:playwright -- --project=chromium
```

For changes that touch a specific adapter, run that adapter's full E2E suite too. PR CI will run the full matrix.

All checks must pass. CI runs the same steps.

## Pull requests

- Keep PRs focused: one feature or fix per PR.
- Include tests for new functionality. Unit + E2E per the table in "Adding a new chaos type".
- Update docs if the public API changes.
- Update `CHANGELOG.md` under `[Unreleased]`.
- Follow existing code style (enforced by ESLint).

## Commit messages

Use [conventional commits](https://www.conventionalcommits.org/) with scopes that match the existing history.

```text
feat(core): add WebSocket chaos support
feat(playwright): re-export new SSE types
fix(cypress): handle command log on retried commands
test(core): cover abort timeout edge case
docs: document Service Worker chaos toggles
chore(ci): bump playwright container image to v1.55.0-noble
chore(deps): bump zod to ^3.25
```

Common scopes: `core`, `playwright`, `cypress`, `webdriverio`, `puppeteer`, `docs`, `ci`, `deps`. Keep the subject line under ~72 chars.

## Reporting issues

- Search existing issues before opening a new one.
- Use the bug-report or feature-request issue template under [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/).
- For bugs: include the adapter, Chaos Maker version, Node version, browser, OS, repro, expected, actual.
- For security issues: do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
