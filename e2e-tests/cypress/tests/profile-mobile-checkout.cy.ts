describe('Profile: mobileCheckout', () => {
  it('built-in profile composes mobile-3g latency on the request path', () => {
    cy.injectChaos({ profile: 'mobile-checkout', seed: 1234 });
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status', { timeout: 10000 }).should('have.text', 'Success!');
    cy.get('#timing').invoke('text').then((text) => {
      expect(parseInt(text, 10)).to.be.greaterThan(1000);
    });
    cy.getChaosLog().then((log) => {
      const events = log as Array<{ type: string; applied: boolean }>;
      expect(events.some((e) => e.type === 'network:latency' && e.applied)).to.be.true;
    });
  });

  it('camelCase mobileCheckout resolves to the same profile', () => {
    cy.injectChaos({ profile: 'mobileCheckout', seed: 1234 });
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status', { timeout: 10000 }).should('have.text', 'Success!');
    cy.getChaosLog().then((log) => {
      const events = log as Array<{ type: string }>;
      expect(events.some((e) => e.type === 'network:latency')).to.be.true;
    });
  });
});
