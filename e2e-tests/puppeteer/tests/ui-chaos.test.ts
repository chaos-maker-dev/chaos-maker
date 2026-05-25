import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { injectChaos, getChaosLog } from '@chaos-maker/puppeteer';
import type { ChaosEvent, ChaosConfig } from '@chaos-maker/core';
import { launchBrowser, BASE_URL } from './helpers';

let browser: Browser;
let page: Page;

beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser.close(); });

beforeEach(async () => { page = await browser.newPage(); });
afterEach(async () => { await page.close(); });

// UI chaos must start AFTER page load  -  the DOM assailant does an initial scan
// of existing elements and attaches a MutationObserver to document.body, both of
// which require the DOM to exist. Inject an empty config pre-nav to load the UMD
// bundle, then start UI chaos via chaosUtils.start() after goto().
async function injectUiChaos(p: Page, config: ChaosConfig): Promise<void> {
  await p.evaluate((cfg) => {
    (window as unknown as { chaosUtils: { start: (c: unknown) => void } }).chaosUtils.start(cfg);
  }, config as object);
}

describe('UI chaos', () => {
  it('disables target button', async () => {
    await injectChaos(page, {});
    await page.goto(BASE_URL);
    await injectUiChaos(page, {
      ui: { assaults: [{ selector: '#submit-btn', action: 'disable', probability: 1.0 }] },
    });

    await page.waitForFunction(
      () => (document.getElementById('submit-btn') as HTMLButtonElement)?.disabled === true,
      { timeout: 5_000 },
    );
    const disabled = await page.$eval(
      '#submit-btn',
      (el) => (el as HTMLButtonElement).disabled,
    );
    expect(disabled).toBe(true);

    const log = await getChaosLog(page) as ChaosEvent[];
    expect(log.some((e) => e.type === 'ui:assault' && e.applied)).toBe(true);
  });

  it('hides target element', async () => {
    await injectChaos(page, {});
    await page.goto(BASE_URL);
    await injectUiChaos(page, {
      ui: { assaults: [{ selector: '#action-btn', action: 'hide', probability: 1.0 }] },
    });

    await page.waitForFunction(
      () => {
        const el = document.getElementById('action-btn') as HTMLElement | null;
        return el?.style.display === 'none';
      },
      { timeout: 5_000 },
    );
    const display = await page.$eval(
      '#action-btn',
      (el) => (el as HTMLElement).style.display,
    );
    expect(display).toBe('none');
  });

  it('removes target element from DOM', async () => {
    await injectChaos(page, {});
    await page.goto(BASE_URL);
    await injectUiChaos(page, {
      ui: { assaults: [{ selector: '#removable-div', action: 'remove', probability: 1.0 }] },
    });

    await page.waitForFunction(
      () => document.getElementById('removable-div') === null,
      { timeout: 5_000 },
    );
    const el = await page.$('#removable-div');
    expect(el).toBeNull();
  });

  it('probability 0 leaves UI unchanged', async () => {
    await injectChaos(page, {});
    await page.goto(BASE_URL);
    await injectUiChaos(page, {
      ui: { assaults: [{ selector: '#submit-btn', action: 'disable', probability: 0 }] },
    });

    await new Promise((r) => setTimeout(r, 200));
    const disabled = await page.$eval(
      '#submit-btn',
      (el) => (el as HTMLButtonElement).disabled,
    );
    expect(disabled).toBe(false);
  });
});
