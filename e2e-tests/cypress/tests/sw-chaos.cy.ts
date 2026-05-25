const SW_BASE = '/sw-app/';

// SW registration needs a real cross-nav  -  Cypress AUT caches window between
// `cy.visit()`s in the same spec, so we unregister in afterEach to guarantee a
// clean slate.

function registerClassicSW(): void {
  cy.visit(SW_BASE);
  cy.window({ log: false }).then(async (win) => {
    const fn = (win as unknown as { __registerClassicSW?: () => Promise<unknown> })
      .__registerClassicSW;
    if (!fn) throw new Error('__registerClassicSW missing');
    await fn();
  });
  cy.window({ log: false, timeout: 10_000 }).should((win) => {
    expect(win.navigator.serviceWorker.controller, 'SW controller present').to.not.equal(null);
  });
}

function unregisterSW(): void {
  cy.window({ log: false }).then(async (win) => {
    const regs = await win.navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
  });
}

describe('SW chaos  -  network failure', () => {
  afterEach(() => {
    cy.removeSWChaos();
    unregisterSW();
  });

  it('injects 503 for SW-fetched /sw-api/* requests', () => {
    registerClassicSW();
    cy.injectSWChaos({
      network: { failures: [{ urlPattern: '/api/data.json', statusCode: 503, probability: 1 }] },
      seed: 1,
    }).then((result) => {
      expect(result.seed).to.equal(1);
    });

    cy.get('#sw-fetch').click();
    cy.get('#sw-fetch-status').should('have.text', '503');
    cy.getSWChaosLog().then((log) => {
      expect(log.some((e) => e.type === 'network:failure' && e.applied)).to.be.true;
    });
  });

  it('injects latency', () => {
    registerClassicSW();
    cy.injectSWChaos({
      network: { latencies: [{ urlPattern: '/api/data.json', delayMs: 400, probability: 1 }] },
      seed: 2,
    });
    // Capture start inside .then so SW registration + inject overhead doesn't
    // leak into the measured window.
    cy.then(() => {
      const start = Date.now();
      cy.get('#sw-fetch').click();
      cy.get('#sw-fetch-status').should('have.text', '200').then(() => {
        expect(Date.now() - start).to.be.at.least(300);
      });
    });
  });
});

describe('SW chaos  -  stop restores fetch', () => {
  afterEach(() => {
    unregisterSW();
  });

  it('removeSWChaos stops injecting failures', () => {
    registerClassicSW();
    cy.injectSWChaos({
      network: { failures: [{ urlPattern: '/api/data.json', statusCode: 503, probability: 1 }] },
      seed: 3,
    });
    cy.get('#sw-fetch').click();
    cy.get('#sw-fetch-status').should('have.text', '503');
    cy.removeSWChaos();
    cy.window({ log: false }).then((win) => {
      win.document.getElementById('sw-fetch-status')!.textContent = '';
    });
    cy.get('#sw-fetch').click();
    cy.get('#sw-fetch-status').should('have.text', '200');
  });

  it('stop then reinject works on a reused SW registration', () => {
    registerClassicSW();
    cy.injectSWChaos({
      network: { failures: [{ urlPattern: '/api/data.json', statusCode: 503, probability: 1 }] },
      seed: 4,
    });
    cy.get('#sw-fetch').click();
    cy.get('#sw-fetch-status').should('have.text', '503');

    cy.removeSWChaos();
    cy.window({ log: false }).then((win) => {
      win.document.getElementById('sw-fetch-status')!.textContent = '';
    });
    cy.get('#sw-fetch').click();
    cy.get('#sw-fetch-status').should('have.text', '200');

    cy.getSWChaosLog().should((log) => {
      expect(log).to.deep.equal([]);
    });
    cy.getSWChaosLogFromSW().should((log) => {
      expect(log).to.deep.equal([]);
    });

    cy.injectSWChaos({
      network: { failures: [{ urlPattern: '/api/data.json', statusCode: 418, probability: 1 }] },
      seed: 5,
    });
    cy.window({ log: false }).then((win) => {
      win.document.getElementById('sw-fetch-status')!.textContent = '';
    });
    cy.get('#sw-fetch').click();
    cy.get('#sw-fetch-status').should('have.text', '418');
  });
});
