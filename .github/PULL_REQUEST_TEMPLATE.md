<!-- Thanks for sending a pull request. Fill in the sections below so the review goes quickly. -->

## Summary

<!-- One or two sentences. What does this change do, and why? -->

## Type of change

- [ ] Bug fix (non-breaking change that resolves an issue)
- [ ] New feature (non-breaking change that adds capability)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Documentation only
- [ ] CI / infrastructure / dependency bump

## Affected packages

- [ ] `@chaos-maker/core`
- [ ] `@chaos-maker/playwright`
- [ ] `@chaos-maker/cypress`
- [ ] `@chaos-maker/webdriverio`
- [ ] `@chaos-maker/puppeteer`
- [ ] Docs site
- [ ] CI / repo tooling

## Test plan

<!-- What did you run locally? Paste output snippets if useful. -->

- [ ] `bun run lint`
- [ ] `bun run test`
- [ ] `bun run build`
- [ ] Relevant adapter E2E (e.g. `bun run test:playwright -- --project=chromium`)
- [ ] `bun run build:docs` (if docs touched)

## Checklist

- [ ] Added or updated unit tests for new behavior.
- [ ] Added or updated E2E coverage on every relevant adapter for new chaos types or public API.
- [ ] Updated `docs/content-source/` for any public API change.
- [ ] Updated `CHANGELOG.md` under `[Unreleased]`.
- [ ] Updated `README.md` / adapter READMEs if surface changed.
- [ ] No em-dashes in user-visible docs or commit messages.
- [ ] No mentions of internal planning identifiers in code, docs, or commit messages.

## Linked issues

<!-- Closes #123 -->
