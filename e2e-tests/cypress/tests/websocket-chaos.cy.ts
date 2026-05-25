const WS_PATTERN = '127.0.0.1:8081';

function connect(): void {
  cy.get('#ws-connect').click();
  cy.get('#ws-status').should('have.text', 'open');
}

function sendMessages(n: number): void {
  for (let i = 0; i < n; i++) {
    cy.get('#ws-send').click();
    cy.wait(30); // serialise sends; chaos timing may reorder otherwise
  }
}

// ---------------------------------------------------------------------------
// Drop  -  outbound messages silently discarded
// ---------------------------------------------------------------------------
describe('WebSocket drop', () => {
  it('drops every 2nd outbound message; server echoes only half', () => {
    cy.injectChaos({
      websocket: {
        drops: [{ urlPattern: WS_PATTERN, direction: 'outbound', probability: 1, everyNth: 2 }],
      },
    });
    cy.visit('/');
    connect();
    sendMessages(4);
    cy.get('#ws-inbound-count', { timeout: 8000 }).should('have.text', '2');
    cy.getChaosLog().then((log) => {
      const drops = log.filter(
        (e) => e.type === 'websocket:drop' && e.detail.direction === 'outbound',
      );
      expect(drops.length).to.equal(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Delay  -  inbound messages held for delayMs before delivery
// ---------------------------------------------------------------------------
describe('WebSocket delay', () => {
  it('delays inbound messages by >= 800ms', () => {
    cy.injectChaos({
      websocket: {
        delays: [{ urlPattern: WS_PATTERN, direction: 'inbound', delayMs: 800, probability: 1 }],
      },
    });
    cy.visit('/');
    connect();

    let sendTime: number;
    cy.get('#ws-send')
      .then(($el) => { sendTime = Date.now(); return $el; })
      .click();
    cy.get('#ws-inbound-count', { timeout: 10_000 })
      .should('have.text', '1')
      .then(() => {
        expect(Date.now() - sendTime).to.be.gte(700);
      });
    cy.getChaosLog().then((log) => {
      expect(log.some((e) => e.type === 'websocket:delay')).to.be.true;
    });
  });
});

// ---------------------------------------------------------------------------
// Corrupt  -  truncate inbound payload
// ---------------------------------------------------------------------------
describe('WebSocket corrupt', () => {
  it('truncates inbound text payload', () => {
    cy.injectChaos({
      websocket: {
        corruptions: [{ urlPattern: WS_PATTERN, direction: 'inbound', strategy: 'truncate', probability: 1 }],
      },
    });
    cy.visit('/');
    connect();
    sendMessages(1);
    cy.get('#ws-inbound-count', { timeout: 5000 }).should('have.text', '1');
    // 'ping' truncated to half → 'pi' (length 2)
    cy.get('#ws-log').invoke('text').should('match', /in \d+ pi\n/);
    cy.getChaosLog().then((log) => {
      const evt = log.find((e) => e.type === 'websocket:corrupt' && e.applied);
      expect(evt?.detail.strategy).to.equal('truncate');
    });
  });
});

// ---------------------------------------------------------------------------
// Close  -  force-close after afterMs with custom code/reason
// ---------------------------------------------------------------------------
describe('WebSocket close', () => {
  it('force-closes after afterMs with configured code and reason', () => {
    cy.injectChaos({
      websocket: {
        closes: [{ urlPattern: WS_PATTERN, probability: 1, afterMs: 500, code: 4000, reason: 'chaos' }],
      },
    });
    cy.visit('/');
    connect();
    cy.get('#ws-status', { timeout: 5000 }).should('contain', 'closed').and('contain', '4000');
    cy.getChaosLog().then((log) => {
      const closes = log.filter((e) => e.type === 'websocket:close' && e.applied);
      expect(closes).to.have.length(1);
      expect(closes[0].detail.closeCode).to.equal(4000);
      expect(closes[0].detail.closeReason).to.equal('chaos');
    });
  });
});

// ---------------------------------------------------------------------------
// Seeded replay  -  same seed → identical drop pattern across two navigations
// ---------------------------------------------------------------------------
describe('WebSocket seeded replay', () => {
  it('same seed produces identical drop outcomes', () => {
    const cfg = {
      seed: 777,
      websocket: {
        drops: [{ urlPattern: WS_PATTERN, direction: 'outbound' as const, probability: 0.5 }],
      },
    };

    let drops1: string[];
    let drops2: string[];

    // Run 1
    cy.injectChaos(cfg);
    cy.visit('/');
    connect();
    sendMessages(6);
    cy.wait(500);
    cy.getChaosLog().then((log) => {
      drops1 = log
        .filter((e) => e.type === 'websocket:drop')
        .map((e) => e.detail.direction as string);
    });

    // Run 2  -  detach handler, re-inject with same seed, reload
    cy.removeChaos();
    cy.injectChaos(cfg);
    cy.visit('/');
    connect();
    sendMessages(6);
    cy.wait(500);
    cy.getChaosLog().then((log) => {
      drops2 = log
        .filter((e) => e.type === 'websocket:drop')
        .map((e) => e.detail.direction as string);
      expect(drops1).to.deep.equal(drops2);
    });
  });
});

// ---------------------------------------------------------------------------
// Counting  -  onNth: 3 drops only the 3rd outbound message
// ---------------------------------------------------------------------------
describe('WebSocket counting', () => {
  it('onNth: 3 drops only the 3rd outbound message', () => {
    cy.injectChaos({
      websocket: {
        drops: [{ urlPattern: WS_PATTERN, direction: 'outbound', probability: 1, onNth: 3 }],
      },
    });
    cy.visit('/');
    connect();
    sendMessages(5);
    cy.get('#ws-inbound-count', { timeout: 8000 }).should('have.text', '4');
    cy.getChaosLog().then((log) => {
      const drops = log.filter(
        (e) => e.type === 'websocket:drop' && e.applied && e.detail.direction === 'outbound',
      );
      expect(drops).to.have.length(1);
    });
  });
});
