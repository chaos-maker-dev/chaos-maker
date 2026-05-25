/// <reference types="cypress" />
import type { ChaosConfig, ChaosEvent } from '@chaos-maker/core';
import { serializeForTransport, validateChaosConfig } from '@chaos-maker/core';
import type { InjectChaosOptions } from './types';

/**
 * Shape of the browser-side `window.chaosUtils` API exposed by the
 * `@chaos-maker/core` UMD bundle after it loads in the AUT window.
 */
interface ChaosUtilsApi {
  instance: unknown;
  start: (config: ChaosConfig) => { success: boolean; message: string };
  stop: () => { success: boolean; message: string };
  getLog: () => ChaosEvent[];
  getSeed: () => number | null;
  enableGroup?: (name: string) => { success: boolean; message: string };
  disableGroup?: (name: string) => { success: boolean; message: string };
}

// Module-level state. Cypress loads the support file once per spec; these
// values persist across `it()` blocks within the spec but reset between specs.
let cachedUmdSource: string | null = null;
let beforeLoadHandler: ((win: Cypress.AUTWindow) => void) | null = null;
let chaosActive = false;

/**
 * Returns true when chaos was injected and not yet removed in the current
 * test. Consumed by the global `afterEach` hook in `support.ts` so auto-remove
 * only runs when there is actually something to tear down.
 */
export function isChaosActive(): boolean {
  return chaosActive;
}

function detachBeforeLoad(): void {
  if (beforeLoadHandler) {
    Cypress.off('window:before:load', beforeLoadHandler);
    beforeLoadHandler = null;
  }
}

function attachChaos(config: ChaosConfig, umdSource: string, persist: boolean): void {
  // Replace any previous listener  -  re-calling injectChaos overrides the
  // prior config rather than layering a second listener.
  detachBeforeLoad();

  // Pre-serialize so RegExp matchers transit cleanly across the test ↔ AUT
  // realm boundary. Caller already passed a `validateChaosConfig`-validated
  // config. RegExp instances created in Cypress's runner realm fail
  // `z.instanceof(RegExp)` validation in the AUT realm; reconstructing in-page
  // via deserializeForTransport sidesteps the cross-realm constructor mismatch.
  const serialized = serializeForTransport(config);

  const handler = (win: Cypress.AUTWindow): void => {
    // Setting the config BEFORE the UMD evaluates triggers the core's
    // auto-start path (packages/core/src/index.ts), which constructs a
    // ChaosMaker and calls .start() for us.
    (win as unknown as { __CHAOS_CONFIG__: ChaosConfig }).__CHAOS_CONFIG__ = serialized;

    const script = win.document.createElement('script');
    script.textContent = umdSource;
    // `<head>` exists by the time `window:before:load` fires. Falling back to
    // `documentElement` covers rare pages that rewrite the document in-flight.
    (win.document.head || win.document.documentElement).appendChild(script);
    // Script tag has done its job  -  remove it so the AUT DOM stays clean.
    script.remove();

    if (!persist) {
      detachBeforeLoad();
    }
  };

  Cypress.on('window:before:load', handler);
  beforeLoadHandler = handler;
  chaosActive = true;
}

/**
 * Register chaos-maker's custom Cypress commands on `Cypress.Commands`.
 *
 * Users normally get this automatically by importing
 * `@chaos-maker/cypress/support` in their `cypress/support/e2e.ts`. Call this
 * directly only if you need fine-grained control over when the commands are
 * registered.
 */
export function registerChaosCommands(): void {
  Cypress.Commands.add('injectChaos', (config: ChaosConfig, options?: InjectChaosOptions) => {
    const persist = options?.persistAcrossNavigations ?? true;

    // Validate synchronously inside the command body so `ChaosConfigError`
    // fails the step before `cy.visit()` runs and before any browser-side
    // bootstrap fires.
    const validated = validateChaosConfig(config, options?.validation);

    if (cachedUmdSource !== null) {
      attachChaos(validated, cachedUmdSource, persist);
      // Explicit return type aligns with `Chainable<void>` on the augmented
      // Cypress.Chainable.injectChaos signature  -  Cypress accepts commands
      // that don't return anything, but this keeps the overload happy.
      return;
    }

    cy.task<string>('chaos:getUmdSource', null, { log: false }).then((src) => {
      cachedUmdSource = src;
      attachChaos(validated, src, persist);
    });
  });

  Cypress.Commands.add('removeChaos', () => {
    detachBeforeLoad();
    chaosActive = false;
    cy.window({ log: false }).then((win) => {
      const utils = (win as unknown as { chaosUtils?: ChaosUtilsApi }).chaosUtils;
      if (utils && typeof utils.stop === 'function') {
        utils.stop();
      }
    });
  });

  Cypress.Commands.add('getChaosLog', () => {
    // Generic hint on `.then<T>` forces the chain's subject to `ChaosEvent[]`
    // rather than the `AUTWindow` of the outer `cy.window`.
    return cy.window({ log: false }).then<ChaosEvent[]>((win) => {
      const utils = (win as unknown as { chaosUtils?: ChaosUtilsApi }).chaosUtils;
      if (utils && typeof utils.getLog === 'function') {
        return utils.getLog();
      }
      return [];
    });
  });

  Cypress.Commands.add('enableGroup', (name: string) => {
    if (typeof name !== 'string') {
      throw new Error('[chaos-maker] group name must be a string');
    }
    const nameNorm = name.trim();
    if (!nameNorm) {
      throw new Error('[chaos-maker] group name cannot be empty');
    }
    cy.window({ log: false }).then((win) => {
      const utils = (win as unknown as { chaosUtils?: ChaosUtilsApi }).chaosUtils;
      if (!utils || !utils.instance) {
        throw new Error('[chaos-maker] no chaos instance  -  call cy.injectChaos() first');
      }
      if (typeof utils.enableGroup !== 'function') {
        throw new Error('[chaos-maker] enableGroup API unavailable');
      }
      const result = utils.enableGroup(nameNorm);
      if (result && result.success === false) {
        throw new Error(`[chaos-maker] enableGroup('${nameNorm}') failed: ${result.message}`);
      }
    });
  });

  Cypress.Commands.add('disableGroup', (name: string) => {
    if (typeof name !== 'string') {
      throw new Error('[chaos-maker] group name must be a string');
    }
    const nameNorm = name.trim();
    if (!nameNorm) {
      throw new Error('[chaos-maker] group name cannot be empty');
    }
    cy.window({ log: false }).then((win) => {
      const utils = (win as unknown as { chaosUtils?: ChaosUtilsApi }).chaosUtils;
      if (!utils || !utils.instance) {
        throw new Error('[chaos-maker] no chaos instance  -  call cy.injectChaos() first');
      }
      if (typeof utils.disableGroup !== 'function') {
        throw new Error('[chaos-maker] disableGroup API unavailable');
      }
      const result = utils.disableGroup(nameNorm);
      if (result && result.success === false) {
        throw new Error(`[chaos-maker] disableGroup('${nameNorm}') failed: ${result.message}`);
      }
    });
  });

  Cypress.Commands.add('getChaosSeed', () => {
    // Cypress's `.then(fn)` overload resolution maps `number | null` to
    // `ThenReturn<AUTWindow, number | null>` which widens to
    // `Chainable<AUTWindow | number | null>`. We narrow to the declared
    // `Chainable<number | null>`  -  at runtime the subject genuinely is the
    // callback's return value (AUTWindow is never propagated).
    return cy.window({ log: false }).then((win) => {
      const utils = (win as unknown as { chaosUtils?: ChaosUtilsApi }).chaosUtils;
      if (utils && typeof utils.getSeed === 'function') {
        return utils.getSeed();
      }
      return null;
    }) as unknown as Cypress.Chainable<number | null>;
  });
}
