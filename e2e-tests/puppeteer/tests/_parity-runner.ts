import type { Page } from 'puppeteer';
import { injectChaos, getChaosLog } from '@chaos-maker/puppeteer';
import type { ChaosEvent } from '@chaos-maker/core';
import type { Scenario, Step } from '../../fixtures/parity/types';
import { strictAssert } from '../../fixtures/parity/assertions';
import { BASE_URL, waitForText } from './helpers';

type RequestStep = Extract<Step, { kind: 'request' }>;

async function runRequest(page: Page, req: RequestStep): Promise<number> {
  // Per LEARNINGS, await the page.evaluate result into a local so the
  // double-promise typing pitfall doesn't surface at the caller boundary.
  const status = await page.evaluate(async (arg) => {
    if (arg.as === 'fetch') {
      const r = await fetch(arg.url, arg.headers ? { headers: arg.headers } : undefined);
      return r.status;
    }
    return new Promise<number>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', arg.url);
      if (arg.headers) {
        for (const k of Object.keys(arg.headers)) xhr.setRequestHeader(k, arg.headers[k]);
      }
      xhr.onloadend = () => resolve(xhr.status);
      xhr.send();
    });
  }, req);
  return status as number;
}

async function waitForCount(page: Page, selector: string, min: number): Promise<void> {
  await page.waitForFunction(
    (sel, m) => Number(document.querySelector(sel)?.textContent) >= m,
    { timeout: 10_000 },
    selector,
    min,
  );
}

/** Execute one parity scenario against a Puppeteer page. The spec file owns
 *  the browser / page lifecycle (one fresh page per `it`); this runner only
 *  drives the scenario's step list and asserts the outcome. */
export async function runScenario(page: Page, scenario: Scenario): Promise<void> {
  await injectChaos(page, scenario.config);
  await page.goto(BASE_URL);

  const captured: Record<string, number> = {};
  for (const step of scenario.steps) {
    if (step.kind === 'click') {
      await page.click(step.selector);
    } else if (step.kind === 'waitForText' || step.kind === 'expectText') {
      await waitForText(page, step.selector, step.text);
    } else if (step.kind === 'waitForCount') {
      await waitForCount(page, step.selector, step.min);
    } else if (step.kind === 'settle') {
      await new Promise((r) => setTimeout(r, step.ms));
    } else if (step.kind === 'request') {
      captured[step.capture] = await runRequest(page, step);
    }
  }

  const log = (await getChaosLog(page)) as ChaosEvent[];
  scenario.check({ log, captured }, strictAssert);
}
