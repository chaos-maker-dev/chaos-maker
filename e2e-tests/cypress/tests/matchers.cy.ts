describe('Advanced matchers', () => {
  it('hostname matcher only fires for the targeted host', () => {
    cy.injectChaos({
      seed: 1,
      network: {
        failures: [
          {
            urlPattern: '*',
            hostname: '127.0.0.1',
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    });
    cy.visit('/');
    cy.window().then(async (win) => {
      const r = await win.fetch('/api/data.json');
      expect(r.status).to.equal(503);
    });
  });

  it('named matcher inlines into a referencing rule', () => {
    cy.injectChaos({
      seed: 1,
      matchers: {
        customers: { urlPattern: '/api/data.json', queryParams: { type: 'customer' } },
      },
      network: {
        failures: [
          { matcher: 'customers', statusCode: 503, probability: 1 },
        ],
      },
    });
    cy.visit('/');
    cy.window().then(async (win) => {
      const matched = await win.fetch('/api/data.json?type=customer');
      expect(matched.status).to.equal(503);
      const missed = await win.fetch('/api/data.json?type=product');
      expect(missed.status).to.equal(200);
    });
  });
});
