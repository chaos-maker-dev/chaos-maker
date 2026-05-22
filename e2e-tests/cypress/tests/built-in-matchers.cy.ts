describe('Built-in matchers', () => {
  it('apiRequests built-in fires on API traffic', () => {
    cy.injectChaos({
      seed: 1,
      network: {
        failures: [{ matcher: 'apiRequests', statusCode: 503, probability: 1 }],
      },
    });
    cy.visit('/');
    cy.window().then(async (win) => {
      const api = await win.fetch('/api/data.json');
      expect(api.status).to.equal(503);
      const other = await win.fetch('/index.html');
      expect(other.status).to.equal(200);
    });
  });

  it('graphql built-in fires on GraphQL endpoint paths', () => {
    cy.injectChaos({
      seed: 1,
      network: {
        failures: [{ matcher: 'graphql', statusCode: 503, probability: 1 }],
      },
    });
    cy.visit('/');
    cy.window().then(async (win) => {
      const gql = await win.fetch('/graphql');
      expect(gql.status).to.equal(503);
      const api = await win.fetch('/api/data.json');
      expect(api.status).to.equal(200);
    });
  });

  it('authRequests built-in fires only on requests carrying an Authorization header', () => {
    cy.injectChaos({
      seed: 1,
      network: {
        failures: [{ matcher: 'authRequests', statusCode: 503, probability: 1 }],
      },
    });
    cy.visit('/');
    cy.window().then(async (win) => {
      const authed = await win.fetch('/api/data.json', {
        headers: { Authorization: 'Bearer token' },
      });
      expect(authed.status).to.equal(503);
      const anon = await win.fetch('/api/data.json');
      expect(anon.status).to.equal(200);
    });
  });

  it('a user matcher overrides the built-in of the same name', () => {
    cy.injectChaos({
      seed: 1,
      matchers: { graphql: { urlPattern: '/api/data.json' } },
      network: {
        failures: [{ matcher: 'graphql', statusCode: 503, probability: 1 }],
      },
    });
    cy.visit('/');
    cy.window().then(async (win) => {
      const overrideTarget = await win.fetch('/api/data.json');
      expect(overrideTarget.status).to.equal(503);
      const builtInPath = await win.fetch('/graphql');
      expect(builtInPath.status).to.not.equal(503);
    });
  });
});
