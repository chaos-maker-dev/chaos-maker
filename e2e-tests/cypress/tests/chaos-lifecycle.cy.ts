import type { ChaosConfig } from '@chaos-maker/core';
import { presets } from '@chaos-maker/core';

const API_PATTERN = '/api/data.json';

function startChaos(config: ChaosConfig): void {
  cy.window().then((win) => {
    (win as unknown as { chaosUtils: { start: (c: ChaosConfig) => void } }).chaosUtils.start(config);
  });
}

// ---------------------------------------------------------------------------
// Chaos removal & restoration
// ---------------------------------------------------------------------------
describe('Chaos Lifecycle', () => {
  it('removeChaos restores normal fetch behavior', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 500, probability: 1.0 }] },
    });
    cy.visit('/');

    // With chaos  -  should fail
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Error!');

    // Remove chaos
    cy.removeChaos();

    // Without chaos  -  should succeed
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Success!');
  });

  it('chaos log captures events with correct structure', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }] },
    });
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Error!');

    cy.getChaosLog().then((log) => {
      expect(log.length).to.be.greaterThan(0);
      for (const event of log) {
        expect(event).to.have.property('type');
        expect(event).to.have.property('timestamp');
        expect(event).to.have.property('applied');
        expect(event).to.have.property('detail');
        expect(event.timestamp).to.be.a('number');
        expect(event.applied).to.be.a('boolean');
      }
    });
  });

  it('chaos log records URL and method in event detail', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 500, probability: 1.0 }] },
    });
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Error!');

    cy.getChaosLog().then((log) => {
      const evt = log.find((e) => e.type === 'network:failure' && e.applied);
      expect(evt).to.exist;
      expect(evt!.detail.url).to.contain(API_PATTERN);
      expect(evt!.detail.method).to.equal('GET');
      expect(evt!.detail.statusCode).to.equal(500);
    });
  });

  it('combined network and UI chaos work simultaneously', () => {
    // Load UMD bundle only; the DOM assailant needs document.body so we call
    // chaosUtils.start() after visit with both network + ui config in a single
    // call (start() replaces any previous instance).
    cy.injectChaos({});
    cy.visit('/');
    startChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }] },
      ui: { assaults: [{ selector: '#submit-btn', action: 'disable', probability: 1.0 }] },
    });

    // Network chaos applied
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Error!');
    // UI chaos applied simultaneously
    cy.get('#submit-btn').should('be.disabled');

    cy.getChaosLog().then((log) => {
      expect(log.some((e) => e.type === 'network:failure')).to.be.true;
      expect(log.some((e) => e.type === 'ui:assault')).to.be.true;
    });
  });

  it('removeChaos survives a reload on a reused page', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 500, probability: 1.0 }] },
    });
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Error!');

    cy.removeChaos();
    cy.reload();
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Success!');

    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }] },
    });
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Error!');

    cy.removeChaos();
    cy.reload();
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Success!');
  });

  it('supports repeated inject and remove cycles across visits', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 500, probability: 1.0 }] },
    });
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Error!');

    cy.removeChaos();
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Success!');

    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }] },
    });
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Error!');

    cy.removeChaos();
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Success!');
  });
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
describe('Presets', () => {
  it('unstableApi preset targets /api/ paths', () => {
    cy.injectChaos(presets.unstableApi);
    cy.visit('/');
    cy.get('#fetch-data').click();
    // Low probabilities  -  the request may or may not be affected. Verify that
    // events (applied or skipped) were emitted for the /api/ match.
    cy.get('#status').should('not.be.empty');
    cy.getChaosLog().then((log) => {
      expect(log.some((e) => e.type === 'network:failure' || e.type === 'network:latency')).to.be.true;
    });
  });

  it('slowNetwork preset adds latency to all requests', () => {
    cy.injectChaos(presets.slowNetwork);
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status', { timeout: 10_000 }).should('have.text', 'Success!');
    cy.get('#timing').invoke('text').then((txt) => {
      expect(parseInt(txt)).to.be.gte(1800);
    });
  });

  it('offlineMode preset blocks all requests', () => {
    cy.injectChaos(presets.offlineMode);
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Error!');
    cy.get('#result').should('contain', 'Failed to fetch');
  });

  it('flakyConnection preset injects chaos events', () => {
    cy.injectChaos(presets.flakyConnection);
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status').should('not.be.empty');
    cy.getChaosLog().then((log) => {
      // Abort (0.05) and latency (0.1) events should be logged (applied or skipped)
      expect(log.some((e) => e.type === 'network:abort' || e.type === 'network:latency')).to.be.true;
    });
  });

  it('degradedUi preset assaults buttons and links', () => {
    // UI preset needs DOM  -  load UMD with empty config, then start after visit
    cy.injectChaos({});
    cy.visit('/');
    startChaos(presets.degradedUi);
    cy.wait(200); // let MutationObserver process

    cy.getChaosLog().then((log) => {
      const uiEvents = log.filter((e) => e.type === 'ui:assault');
      expect(uiEvents.length).to.be.greaterThan(0);
    });
  });
});
