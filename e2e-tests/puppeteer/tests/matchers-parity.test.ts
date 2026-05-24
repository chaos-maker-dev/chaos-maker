// The parity catalog drives every adapter through the same dynamic titles
// and asserts via its own throw-based shim (`strictAssert`), not vitest's
// `expect`. Disable the two vitest rules that flag the dynamic-title /
// no-`expect` pattern.
/* eslint-disable vitest/valid-title, vitest/expect-expect */

import { describe, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser } from './helpers';
import { catalog } from '../../fixtures/parity/catalog';
import { runScenario } from './_parity-runner';

describe('Matcher parity', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });
  beforeEach(async () => {
    page = await browser.newPage();
  });
  afterEach(async () => {
    await page.close();
  });

  for (const scenario of catalog) {
    it(scenario.title, async () => {
      await runScenario(page, scenario);
    });
  }
});
