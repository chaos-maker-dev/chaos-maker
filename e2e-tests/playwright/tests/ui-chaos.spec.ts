import { test, expect } from '@playwright/test';
import { injectChaos, getChaosLog } from '@chaos-maker/playwright';
import type { ChaosConfig } from '@chaos-maker/playwright';

const BASE_URL = 'http://127.0.0.1:8080';

// UI chaos must be started AFTER page load  -  the DOM assailant does an initial
// scan of existing elements and attaches a MutationObserver to document.body,
// both of which require the DOM to exist. We use injectChaos with an empty
// config to load the UMD bundle (which sets up window.chaosUtils), then call
// chaosUtils.start() with the real UI config after page.goto().
test.beforeEach(async ({ page }) => {
  await injectChaos(page, {});
});

async function injectUiChaos(page: import('@playwright/test').Page, config: ChaosConfig) {
  await page.evaluate((cfg) => {
    (window as any).chaosUtils.start(cfg);
  }, config);
}

test.describe('UI Assaults', () => {
  test('disables targeted buttons', async ({ page }) => {
    await page.goto(BASE_URL);
    await injectUiChaos(page, {
      ui: {
        assaults: [{ selector: '#submit-btn', action: 'disable', probability: 1.0 }],
      },
    });

    await expect(page.locator('#submit-btn')).toBeDisabled();
    // Other buttons should remain enabled
    await expect(page.locator('#action-btn')).toBeEnabled();
  });

  test('hides targeted elements', async ({ page }) => {
    await page.goto(BASE_URL);
    await injectUiChaos(page, {
      ui: {
        assaults: [{ selector: '#nav-link', action: 'hide', probability: 1.0 }],
      },
    });

    await expect(page.locator('#nav-link')).toBeHidden();
    // Other elements remain visible
    await expect(page.locator('#submit-btn')).toBeVisible();
  });

  test('removes targeted elements from DOM', async ({ page }) => {
    await page.goto(BASE_URL);
    await injectUiChaos(page, {
      ui: {
        assaults: [{ selector: '#removable-div', action: 'remove', probability: 1.0 }],
      },
    });

    await expect(page.locator('#removable-div')).toHaveCount(0);
  });

  test('assaults dynamically added elements via MutationObserver', async ({ page }) => {
    await page.goto(BASE_URL);
    await injectUiChaos(page, {
      ui: {
        assaults: [{ selector: '.dynamic-btn', action: 'disable', probability: 1.0 }],
      },
    });

    // No dynamic buttons yet
    await expect(page.locator('.dynamic-btn')).toHaveCount(0);

    // Add one dynamically  -  MutationObserver should catch it
    await page.click('#add-dynamic');
    const btn = page.locator('.dynamic-btn');
    await expect(btn).toHaveCount(1);
    await expect(btn).toBeDisabled();
  });

  test('skips assault when probability is 0', async ({ page }) => {
    await page.goto(BASE_URL);
    await injectUiChaos(page, {
      ui: {
        assaults: [{ selector: '#submit-btn', action: 'disable', probability: 0 }],
      },
    });

    await expect(page.locator('#submit-btn')).toBeEnabled();
  });

  test('applies multiple assaults simultaneously', async ({ page }) => {
    await page.goto(BASE_URL);
    await injectUiChaos(page, {
      ui: {
        assaults: [
          { selector: '#submit-btn', action: 'disable', probability: 1.0 },
          { selector: '#nav-link', action: 'hide', probability: 1.0 },
          { selector: '#removable-div', action: 'remove', probability: 1.0 },
        ],
      },
    });

    await expect(page.locator('#submit-btn')).toBeDisabled();
    await expect(page.locator('#nav-link')).toBeHidden();
    await expect(page.locator('#removable-div')).toHaveCount(0);
  });

  test('logs UI assault events', async ({ page }) => {
    await page.goto(BASE_URL);
    await injectUiChaos(page, {
      ui: {
        assaults: [{ selector: 'button', action: 'disable', probability: 1.0 }],
      },
    });

    const log = await getChaosLog(page);
    const uiEvents = log.filter(e => e.type === 'ui:assault');
    expect(uiEvents.length).toBeGreaterThan(0);
    expect(uiEvents.some(e => e.applied)).toBe(true);
  });
});
