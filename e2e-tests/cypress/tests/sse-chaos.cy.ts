const SSE_PATTERN = '127.0.0.1:8082';

function connect(): void {
  cy.get('#sse-connect').click();
  cy.get('#sse-status').should('have.text', 'open');
}

function connectNamed(): void {
  cy.get('#sse-connect-named').click();
  cy.get('#sse-status').should('have.text', 'open');
}

// ---------------------------------------------------------------------------
// Drop  -  every 2nd inbound message is silently discarded.
// ---------------------------------------------------------------------------
describe('SSE drop', () => {
  it('drops every 2nd inbound event', () => {
    cy.injectChaos({
      sse: { drops: [{ urlPattern: SSE_PATTERN, probability: 1, everyNth: 2 }] },
    });
    cy.visit('/');
    connect();
    cy.wait(1500);
    cy.get('#sse-message-count').then(($el) => {
      expect(Number($el.text())).to.be.greaterThan(0);
    });
    cy.getChaosLog().then((log) => {
      const drops = log.filter((e) => e.type === 'sse:drop' && e.applied);
      expect(drops.length).to.be.greaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Delay  -  every event is held for delayMs before delivery.
// ---------------------------------------------------------------------------
describe('SSE delay', () => {
  it('delays inbound messages by >= 600ms', () => {
    cy.injectChaos({
      sse: { delays: [{ urlPattern: SSE_PATTERN, delayMs: 800, probability: 1 }] },
    });
    cy.visit('/');
    connect();
    let connectTime: number;
    cy.get('#sse-status')
      .should('have.text', 'open')
      .then(() => { connectTime = Date.now(); });
    cy.get('#sse-message-count', { timeout: 10_000 })
      .should(($el) => {
        expect(Number($el.text())).to.be.gte(1);
      })
      .then(() => {
        // First message arrives 200ms after connect (server tick) plus 800ms
        // chaos delay = >= 1000ms; allow generous slack for runner jitter.
        expect(Date.now() - connectTime).to.be.gte(700);
      });
    cy.getChaosLog().then((log) => {
      expect(log.some((e) => e.type === 'sse:delay')).to.be.true;
    });
  });
});

// ---------------------------------------------------------------------------
// Corrupt  -  truncate strategy halves event.data text.
// ---------------------------------------------------------------------------
describe('SSE corrupt', () => {
  it('truncates inbound text payload', () => {
    cy.injectChaos({
      sse: { corruptions: [{ urlPattern: SSE_PATTERN, strategy: 'truncate', probability: 1 }] },
    });
    cy.visit('/');
    connect();
    cy.get('#sse-message-count', { timeout: 5000 }).should(($el) => {
      expect(Number($el.text())).to.be.gte(1);
    });
    cy.get('#sse-log').invoke('text').should('match', /msg \d+ tic/);
    cy.getChaosLog().then((log) => {
      const evt = log.find((e) => e.type === 'sse:corrupt' && e.applied);
      expect(evt?.detail.strategy).to.equal('truncate');
    });
  });
});

// ---------------------------------------------------------------------------
// Close  -  force-close the EventSource after afterMs.
// ---------------------------------------------------------------------------
describe('SSE close', () => {
  it('force-closes the source after afterMs', () => {
    cy.injectChaos({
      sse: { closes: [{ urlPattern: SSE_PATTERN, probability: 1, afterMs: 600 }] },
    });
    cy.visit('/');
    connect();
    cy.get('#sse-status', { timeout: 5000 }).should('contain', 'error');
    cy.getChaosLog().then((log) => {
      const closes = log.filter((e) => e.type === 'sse:close' && e.applied);
      expect(closes).to.have.length(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Named event  -  eventType filter targets only the named event.
// ---------------------------------------------------------------------------
describe('SSE named eventType', () => {
  it('drops only "tick" events; default messages survive', () => {
    cy.injectChaos({
      sse: { drops: [{ urlPattern: '/sse-named', eventType: 'tick', probability: 1 }] },
    });
    cy.visit('/');
    connectNamed();
    cy.wait(1500);
    cy.get('#sse-tick-count').should('have.text', '0');
    cy.get('#sse-message-count').then(($el) => {
      expect(Number($el.text())).to.be.greaterThan(0);
    });
    cy.getChaosLog().then((log) => {
      const drops = log.filter((e) => e.type === 'sse:drop' && e.applied);
      expect(drops.length).to.be.greaterThan(0);
      expect(drops.every((e) => e.detail.eventType === 'tick')).to.be.true;
    });
  });
});
