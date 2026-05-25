import type { ChaosConfig } from '@chaos-maker/core';

// UI chaos assaults the DOM after page load. Strategy:
//   1. cy.injectChaos({}) in beforeEach  -  loads the UMD bundle with an empty
//      config so window.chaosUtils is available immediately after page load.
//   2. cy.visit('/') in each test  -  page loads, bundle runs, chaosUtils ready.
//   3. startUiChaos() calls chaosUtils.start() with the real UI config so the
//      assailant can scan and observe the live DOM.
beforeEach(() => {
  cy.injectChaos({});
});

function startUiChaos(config: ChaosConfig): void {
  cy.window().then((win) => {
    (win as unknown as { chaosUtils: { start: (c: ChaosConfig) => void } }).chaosUtils.start(config);
  });
}

describe('UI Assaults', () => {
  it('disables targeted buttons', () => {
    cy.visit('/');
    startUiChaos({ ui: { assaults: [{ selector: '#submit-btn', action: 'disable', probability: 1.0 }] } });
    cy.get('#submit-btn').should('be.disabled');
    cy.get('#action-btn').should('be.enabled');
  });

  it('hides targeted elements', () => {
    cy.visit('/');
    startUiChaos({ ui: { assaults: [{ selector: '#nav-link', action: 'hide', probability: 1.0 }] } });
    cy.get('#nav-link').should('not.be.visible');
    cy.get('#submit-btn').should('be.visible');
  });

  it('removes targeted elements from DOM', () => {
    cy.visit('/');
    startUiChaos({ ui: { assaults: [{ selector: '#removable-div', action: 'remove', probability: 1.0 }] } });
    cy.get('#removable-div').should('not.exist');
  });

  it('assaults dynamically added elements via MutationObserver', () => {
    cy.visit('/');
    startUiChaos({ ui: { assaults: [{ selector: '.dynamic-btn', action: 'disable', probability: 1.0 }] } });
    cy.get('.dynamic-btn').should('not.exist');
    cy.get('#add-dynamic').click();
    cy.get('.dynamic-btn').should('exist').and('be.disabled');
  });

  it('skips assault when probability is 0', () => {
    cy.visit('/');
    startUiChaos({ ui: { assaults: [{ selector: '#submit-btn', action: 'disable', probability: 0 }] } });
    cy.get('#submit-btn').should('be.enabled');
  });

  it('applies multiple assaults simultaneously', () => {
    cy.visit('/');
    startUiChaos({
      ui: {
        assaults: [
          { selector: '#submit-btn', action: 'disable', probability: 1.0 },
          { selector: '#nav-link', action: 'hide', probability: 1.0 },
          { selector: '#removable-div', action: 'remove', probability: 1.0 },
        ],
      },
    });
    cy.get('#submit-btn').should('be.disabled');
    cy.get('#nav-link').should('not.be.visible');
    cy.get('#removable-div').should('not.exist');
  });

  it('logs UI assault events', () => {
    cy.visit('/');
    startUiChaos({ ui: { assaults: [{ selector: 'button', action: 'disable', probability: 1.0 }] } });
    cy.getChaosLog().then((log) => {
      const uiEvents = log.filter((e) => e.type === 'ui:assault');
      expect(uiEvents.length).to.be.greaterThan(0);
      expect(uiEvents.some((e) => e.applied)).to.be.true;
    });
  });
});
