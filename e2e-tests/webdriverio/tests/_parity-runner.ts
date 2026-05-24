import { browser, $ } from '@wdio/globals';
import type { ChaosEvent } from '@chaos-maker/core';
import type { Scenario, Step } from '../../fixtures/parity/types';
import { strictAssert } from '../../fixtures/parity/assertions';

type RequestStep = Extract<Step, { kind: 'request' }>;

async function runRequest(req: RequestStep): Promise<number> {
  // Per LEARNINGS, returning the result of `browser.execute(async ...)`
  // directly through the outer `async` wrapper types as `Promise<Promise<T>>`.
  // Await into a local and cast once.
  const status = await browser.execute(async (arg) => {
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

/** Register one parity scenario as a WebdriverIO `it`. WDIO has no
 *  pre-navigation hook, so the page must be loaded BEFORE chaos is injected
 *  (otherwise the about:blank target is discarded and the patches never reach
 *  the AUT). */
export function registerScenario(scenario: Scenario): void {
  it(scenario.title, async () => {
    await browser.url('/');
    await browser.injectChaos(scenario.config);

    const captured: Record<string, number> = {};
    for (const step of scenario.steps) {
      if (step.kind === 'click') {
        await $(step.selector).click();
      } else if (step.kind === 'waitForText' || step.kind === 'expectText') {
        await browser.waitUntil(
          async () => (await $(step.selector).getText()) === step.text,
          { timeout: 10_000, timeoutMsg: `${step.selector} never became "${step.text}"` },
        );
      } else if (step.kind === 'waitForCount') {
        await browser.waitUntil(
          async () => Number(await $(step.selector).getText()) >= step.min,
          { timeout: 10_000, timeoutMsg: `${step.selector} stayed below ${step.min}` },
        );
      } else if (step.kind === 'settle') {
        await browser.pause(step.ms);
      } else if (step.kind === 'request') {
        captured[step.capture] = await runRequest(step);
      }
    }

    const log = (await browser.getChaosLog()) as ChaosEvent[];
    scenario.check({ log, captured }, strictAssert);
  });
}
