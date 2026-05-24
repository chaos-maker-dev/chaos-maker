import type { ChaosEvent } from '@chaos-maker/core';
import type { Scenario, Step } from '../../fixtures/parity/types';
import { strictAssert } from '../../fixtures/parity/assertions';

type RequestStep = Extract<Step, { kind: 'request' }>;

/** Runs a request inside the application-under-test window. Cypress drives
 *  the spec from inside the same browser, so the request is issued through
 *  the AUT's own `fetch` / `XMLHttpRequest` and therefore passes through the
 *  chaos-maker patches injected on this page. */
function runRequest(win: Window, req: RequestStep): Promise<number> {
  if (req.as === 'fetch') {
    return win
      .fetch(req.url, req.headers ? { headers: req.headers } : undefined)
      .then((r) => r.status);
  }
  return new Promise<number>((resolve) => {
    const xhr = new win.XMLHttpRequest();
    xhr.open('GET', req.url);
    if (req.headers) {
      for (const k of Object.keys(req.headers)) xhr.setRequestHeader(k, req.headers[k]);
    }
    xhr.onloadend = () => resolve(xhr.status);
    xhr.send();
  });
}

/** Register one parity scenario as a Cypress `it`. Every command enqueues
 *  synchronously when the test body runs; Cypress drains the queue in order,
 *  so a `request` step's `.then` (which populates `captured`) is guaranteed
 *  to have run before the trailing `cy.getChaosLog().then(...)` invokes
 *  `scenario.check`. */
export function registerScenario(scenario: Scenario): void {
  it(scenario.title, () => {
    const captured: Record<string, number> = {};
    cy.injectChaos(scenario.config);
    cy.visit('/');

    for (const step of scenario.steps) {
      if (step.kind === 'click') {
        cy.get(step.selector).click();
      } else if (step.kind === 'waitForText') {
        // Retrying assertion: Cypress polls until the text matches or the
        // command times out. Used when the value is still settling.
        cy.get(step.selector).should('have.text', step.text);
      } else if (step.kind === 'expectText') {
        // Immediate assertion: read the element once and check the current
        // text exactly. `cy.get(...)` still retries for element existence,
        // but `.then` runs the body once with the resolved element and does
        // not re-evaluate on mismatch, preserving the catalog's intent that
        // the value should already be settled at this point.
        const expected = step.text;
        cy.get(step.selector).then(($el) => {
          const actual = $el.text();
          if (actual !== expected) {
            throw new Error(
              `${step.selector} text expected "${expected}", got "${actual}"`,
            );
          }
        });
      } else if (step.kind === 'waitForCount') {
        const min = step.min;
        cy.get(step.selector, { timeout: 10_000 }).should((el) => {
          const text = el.text();
          const parsed = Number(text);
          if (Number.isNaN(parsed)) {
            // `Number('abc') < min` is `false`, so without a NaN guard a
            // non-numeric value would silently satisfy the assertion.
            throw new Error(
              `${step.selector} text "${text}" is not numeric; expected count >= ${min}`,
            );
          }
          if (parsed < min) {
            throw new Error(
              `${step.selector} count ${parsed} stayed below ${min}`,
            );
          }
        });
      } else if (step.kind === 'settle') {
        cy.wait(step.ms);
      } else if (step.kind === 'request') {
        const captureKey = step.capture;
        const req = step;
        cy.window().then((win) =>
          runRequest(win, req).then((status) => {
            captured[captureKey] = status;
          }),
        );
      }
    }

    cy.getChaosLog().then((log) => {
      scenario.check({ log: log as ChaosEvent[], captured }, strictAssert);
    });
  });
}
