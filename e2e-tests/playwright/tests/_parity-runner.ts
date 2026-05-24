import { test, expect, type Page } from '@playwright/test';
import { injectChaos, getChaosLog } from '@chaos-maker/playwright';
import type { Scenario, Step } from '../../fixtures/parity/types';
import { strictAssert } from '../../fixtures/parity/assertions';

const BASE_URL = 'http://127.0.0.1:8080';

type RequestStep = Extract<Step, { kind: 'request' }>;

async function runRequest(page: Page, arg: RequestStep): Promise<number> {
  return page.evaluate(async (req) => {
    if (req.as === 'fetch') {
      const r = await fetch(req.url, req.headers ? { headers: req.headers } : undefined);
      return r.status;
    }
    return new Promise<number>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', req.url);
      if (req.headers) {
        for (const k of Object.keys(req.headers)) xhr.setRequestHeader(k, req.headers[k]);
      }
      xhr.onloadend = () => resolve(xhr.status);
      xhr.send();
    });
  }, arg);
}

/** Register one parity scenario as a Playwright `test`. The interpreter
 *  injects chaos, navigates the fixture page, and walks the scenario's step
 *  list, then hands the chaos log plus captured statuses to the scenario's
 *  pure `check` function. */
export function registerScenario(scenario: Scenario): void {
  test(scenario.title, async ({ page }) => {
    await injectChaos(page, scenario.config);
    await page.goto(BASE_URL);

    const captured: Record<string, number> = {};
    for (const step of scenario.steps) {
      if (step.kind === 'click') {
        await page.click(step.selector);
      } else if (step.kind === 'waitForText' || step.kind === 'expectText') {
        await expect(page.locator(step.selector)).toHaveText(step.text);
      } else if (step.kind === 'waitForCount') {
        await page.waitForFunction(
          ({ sel, min }) => Number(document.querySelector(sel)?.textContent) >= min,
          { sel: step.selector, min: step.min },
          { timeout: 10_000 },
        );
      } else if (step.kind === 'settle') {
        await page.waitForTimeout(step.ms);
      } else if (step.kind === 'request') {
        captured[step.capture] = await runRequest(page, step);
      }
    }

    const log = await getChaosLog(page);
    scenario.check({ log, captured }, strictAssert);
  });
}
