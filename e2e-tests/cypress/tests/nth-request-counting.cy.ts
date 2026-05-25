const API_PATTERN = '/api/data.json';

/** Click a button and wait for the status element to leave "Loading..." state. */
function makeRequest(buttonId = '#fetch-data', statusId = '#status'): void {
  cy.get(buttonId).click();
  cy.get(statusId).should('not.have.text', 'Loading...');
}

// ---------------------------------------------------------------------------
// onNth  -  failure fires only on the Nth request
// ---------------------------------------------------------------------------
describe('onNth counting', () => {
  it('fetch: fails only on the 3rd request', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, onNth: 3 }] },
    });
    cy.visit('/');

    makeRequest();
    cy.get('#status').should('have.text', 'Success!');
    makeRequest();
    cy.get('#status').should('have.text', 'Success!');
    makeRequest();
    cy.get('#status').should('have.text', 'Error!');
    makeRequest();
    cy.get('#status').should('have.text', 'Success!');

    cy.getChaosLog().then((log) => {
      const failures = log.filter((e) => e.type === 'network:failure');
      expect(failures).to.have.length(1);
      expect(failures[0].applied).to.be.true;
    });
  });

  it('fetch: fails only on the 1st request when onNth is 1', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 500, probability: 1.0, onNth: 1 }] },
    });
    cy.visit('/');

    makeRequest();
    cy.get('#status').should('have.text', 'Error!');
    makeRequest();
    cy.get('#status').should('have.text', 'Success!');
    makeRequest();
    cy.get('#status').should('have.text', 'Success!');
  });

  it('XHR: fails only on the 2nd request', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, onNth: 2 }] },
    });
    cy.visit('/');

    makeRequest('#xhr-get', '#xhr-status');
    cy.get('#xhr-status').should('have.text', 'Success!');
    makeRequest('#xhr-get', '#xhr-status');
    cy.get('#xhr-status').should('have.text', 'Error!');
    makeRequest('#xhr-get', '#xhr-status');
    cy.get('#xhr-status').should('have.text', 'Success!');
  });
});

// ---------------------------------------------------------------------------
// everyNth  -  failure fires on every Nth request
// ---------------------------------------------------------------------------
describe('everyNth counting', () => {
  it('fetch: fails on every 2nd request', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, everyNth: 2 }] },
    });
    cy.visit('/');

    // Requests 1,3,5 succeed; 2,4,6 fail
    const expected = ['Success!', 'Error!', 'Success!', 'Error!', 'Success!', 'Error!'];
    for (const want of expected) {
      makeRequest();
      cy.get('#status').should('have.text', want);
    }
  });

  it('fetch: fails on every 3rd request', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, everyNth: 3 }] },
    });
    cy.visit('/');

    const expected = ['Success!', 'Success!', 'Error!', 'Success!', 'Success!', 'Error!'];
    for (const want of expected) {
      makeRequest();
      cy.get('#status').should('have.text', want);
    }
  });

  it('fetch: latency applied on every 2nd request', () => {
    const DELAY = 800;
    const THRESHOLD = 500;

    cy.injectChaos({
      network: { latencies: [{ urlPattern: API_PATTERN, delayMs: DELAY, probability: 1.0, everyNth: 2 }] },
    });
    cy.visit('/');

    // Request 1: no latency  -  record timing
    makeRequest();
    let t1 = 0;
    cy.get('#timing').invoke('text').then((txt) => { t1 = parseInt(txt); });

    // Request 2: latency injected
    makeRequest();
    let t2 = 0;
    cy.get('#timing').invoke('text').then((txt) => { t2 = parseInt(txt); });

    // Request 3: no latency again
    makeRequest();
    let t3 = 0;
    cy.get('#timing').invoke('text').then((txt) => {
      t3 = parseInt(txt);
      expect(t2).to.be.gte(DELAY);
      expect(t2 - t1).to.be.gte(THRESHOLD);
      expect(t2 - t3).to.be.gte(THRESHOLD);
    });
  });
});

// ---------------------------------------------------------------------------
// afterN  -  failure fires only after the first N requests pass through
// ---------------------------------------------------------------------------
describe('afterN counting', () => {
  it('fetch: first 2 requests succeed, all subsequent fail', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, afterN: 2 }] },
    });
    cy.visit('/');

    const expected = ['Success!', 'Success!', 'Error!', 'Error!', 'Error!'];
    for (const want of expected) {
      makeRequest();
      cy.get('#status').should('have.text', want);
    }
  });

  it('fetch: afterN 0  -  every request fails', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, afterN: 0 }] },
    });
    cy.visit('/');

    for (let i = 0; i < 3; i++) {
      makeRequest();
      cy.get('#status').should('have.text', 'Error!');
    }
  });

  it('XHR: first 3 succeed, then all fail', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, afterN: 3 }] },
    });
    cy.visit('/');

    const expected = ['Success!', 'Success!', 'Success!', 'Error!', 'Error!'];
    for (const want of expected) {
      makeRequest('#xhr-get', '#xhr-status');
      cy.get('#xhr-status').should('have.text', want);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-transport  -  fetch and XHR share the same counter
// ---------------------------------------------------------------------------
describe('cross-transport counting (fetch + XHR share counter)', () => {
  it('onNth=2: counter increments across fetch and XHR together', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0, onNth: 2 }] },
    });
    cy.visit('/');

    // Request 1 via fetch (count=1) → success
    makeRequest('#fetch-data', '#status');
    cy.get('#status').should('have.text', 'Success!');

    // Request 2 via XHR (count=2) → should fail (shared counter)
    makeRequest('#xhr-get', '#xhr-status');
    cy.get('#xhr-status').should('have.text', 'Error!');

    // Request 3 via fetch (count=3) → success
    makeRequest('#fetch-data', '#status');
    cy.get('#status').should('have.text', 'Success!');
  });
});

// ---------------------------------------------------------------------------
// Counting combined with probability < 1.0
// ---------------------------------------------------------------------------
describe('counting combined with probability', () => {
  it('onNth=3 with probability 0 never fires on any request', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 0, onNth: 3 }] },
    });
    cy.visit('/');

    for (let i = 0; i < 5; i++) {
      makeRequest();
      cy.get('#status').should('have.text', 'Success!');
    }
  });
});
