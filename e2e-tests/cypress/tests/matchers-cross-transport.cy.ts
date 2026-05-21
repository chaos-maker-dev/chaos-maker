describe('Cross-transport matchers', () => {
  it('WS named matcher fires when hostname matches registered entry', () => {
    cy.injectChaos({
      seed: 42,
      matchers: { realtime: { hostname: '127.0.0.1' } },
      websocket: {
        drops: [
          { matcher: 'realtime', direction: 'outbound', probability: 1 },
        ],
      },
    });
    cy.visit('/');
    cy.get('#ws-connect').click();
    cy.get('#ws-status').should('have.text', 'open');
    cy.get('#ws-send').click();
    cy.wait(500);
    cy.get('#ws-inbound-count').should('have.text', '0');
    cy.getChaosLog().then((log) => {
      const drops = log.filter((e) => e.type === 'websocket:drop' && e.applied);
      expect(drops.length).to.be.gte(1);
    });
  });

  it('WS inline queryParams fires for ?room=alpha and skips for ?room=beta', () => {
    cy.injectChaos({
      seed: 42,
      websocket: {
        drops: [
          {
            urlPattern: '127.0.0.1:8081',
            direction: 'outbound',
            queryParams: { room: 'alpha' },
            probability: 1,
          },
        ],
      },
    });
    cy.visit('/');
    cy.get('#ws-connect-alpha').click();
    cy.get('#ws-status').should('have.text', 'open');
    cy.get('#ws-send').click();
    cy.wait(500);
    cy.get('#ws-inbound-count').should('have.text', '0');

    // Re-inject with same config and connect to ?room=beta — chaos must NOT fire.
    cy.removeChaos();
    cy.injectChaos({
      seed: 42,
      websocket: {
        drops: [
          {
            urlPattern: '127.0.0.1:8081',
            direction: 'outbound',
            queryParams: { room: 'alpha' },
            probability: 1,
          },
        ],
      },
    });
    cy.visit('/');
    cy.get('#ws-connect-beta').click();
    cy.get('#ws-status').should('have.text', 'open');
    cy.get('#ws-send').click();
    cy.get('#ws-inbound-count', { timeout: 5000 }).should('have.text', '1');
  });

  it('SSE named matcher fires on registered hostname', () => {
    cy.injectChaos({
      seed: 42,
      matchers: { feed: { hostname: '127.0.0.1' } },
      sse: {
        drops: [{ matcher: 'feed', probability: 1 }],
      },
    });
    cy.visit('/');
    cy.get('#sse-connect-alerts').click();
    cy.get('#sse-status').should('have.text', 'open');
    cy.wait(1000);
    cy.get('#sse-message-count').should('have.text', '0');
    cy.getChaosLog().then((log) => {
      const drops = log.filter((e) => e.type === 'sse:drop' && e.applied);
      expect(drops.length).to.be.gte(1);
    });
  });

  it('SSE inline queryParams fires for ?topic=alerts and skips for ?topic=quotes', () => {
    cy.injectChaos({
      seed: 42,
      sse: {
        drops: [
          {
            urlPattern: '/sse-topics',
            queryParams: { topic: 'alerts' },
            probability: 1,
          },
        ],
      },
    });
    cy.visit('/');
    cy.get('#sse-connect-alerts').click();
    cy.get('#sse-status').should('have.text', 'open');
    cy.wait(1000);
    cy.get('#sse-message-count').should('have.text', '0');

    cy.removeChaos();
    cy.injectChaos({
      seed: 42,
      sse: {
        drops: [
          {
            urlPattern: '/sse-topics',
            queryParams: { topic: 'alerts' },
            probability: 1,
          },
        ],
      },
    });
    cy.visit('/');
    cy.get('#sse-connect-quotes').click();
    cy.get('#sse-status').should('have.text', 'open');
    cy.get('#sse-message-count', { timeout: 5000 }).should((el) => {
      expect(Number(el.text())).to.be.gte(1);
    });
  });

  it('debug event surfaces matchedBy on WS drop', () => {
    cy.injectChaos({
      seed: 42,
      debug: true,
      websocket: {
        drops: [
          {
            urlPattern: '127.0.0.1:8081',
            direction: 'outbound',
            hostname: '127.0.0.1',
            probability: 1,
          },
        ],
      },
    });
    cy.visit('/');
    cy.get('#ws-connect').click();
    cy.get('#ws-status').should('have.text', 'open');
    cy.get('#ws-send').click();
    cy.wait(300);
    cy.getChaosLog().then((log) => {
      const matched = log.find(
        (e) =>
          e.type === 'debug' &&
          e.detail.stage === 'rule-matched' &&
          Array.isArray(e.detail.matchedBy) &&
          (e.detail.matchedBy as string[]).includes('hostname'),
      );
      expect(matched).to.not.be.undefined;
    });
  });
});
