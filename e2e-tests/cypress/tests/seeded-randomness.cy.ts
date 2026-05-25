const API_PATTERN = '/api/data.json';
const SEED = 42;

describe('Seeded Randomness', () => {
  it('same seed produces identical chaos outcomes across runs', () => {
    const config = {
      seed: SEED,
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 0.5 }] },
    };

    let outcomes1: boolean[];
    let outcomes2: boolean[];

    // Run 1
    cy.injectChaos(config);
    cy.visit('/');
    for (let i = 0; i < 5; i++) {
      cy.get('#fetch-data').click();
      cy.get('#status').should('not.have.text', 'Loading...');
    }
    cy.getChaosLog().then((log) => {
      outcomes1 = log.filter((e) => e.type === 'network:failure').map((e) => e.applied);
    });

    // Run 2 with the same seed  -  detach handler then re-inject before page reload
    cy.removeChaos();
    cy.injectChaos(config);
    cy.visit('/');
    for (let i = 0; i < 5; i++) {
      cy.get('#fetch-data').click();
      cy.get('#status').should('not.have.text', 'Loading...');
    }
    cy.getChaosLog().then((log) => {
      outcomes2 = log.filter((e) => e.type === 'network:failure').map((e) => e.applied);
      expect(outcomes1).to.deep.equal(outcomes2);
      expect(outcomes1).to.have.length(5);
    });
  });

  it('different seeds produce different chaos outcomes', () => {
    const baseConfig = {
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 0.5 }] },
    };

    let outcomes1: boolean[];
    let outcomes2: boolean[];

    // Run 1 with seed 42
    cy.injectChaos({ seed: 42, ...baseConfig });
    cy.visit('/');
    for (let i = 0; i < 10; i++) {
      cy.get('#fetch-data').click();
      cy.get('#status').should('not.have.text', 'Loading...');
    }
    cy.getChaosLog().then((log) => {
      outcomes1 = log.filter((e) => e.type === 'network:failure').map((e) => e.applied);
    });

    // Run 2 with seed 99
    cy.removeChaos();
    cy.injectChaos({ seed: 99, ...baseConfig });
    cy.visit('/');
    for (let i = 0; i < 10; i++) {
      cy.get('#fetch-data').click();
      cy.get('#status').should('not.have.text', 'Loading...');
    }
    cy.getChaosLog().then((log) => {
      outcomes2 = log.filter((e) => e.type === 'network:failure').map((e) => e.applied);
      // With 10 trials at p=0.5, probability of two different seeds matching is 1/1024
      expect(outcomes1).not.to.deep.equal(outcomes2);
    });
  });

  it('getSeed returns the seed used by the instance', () => {
    cy.injectChaos({
      seed: 12345,
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }] },
    });
    cy.visit('/');
    cy.getChaosSeed().should('equal', 12345);
  });

  it('auto-generated seed is retrievable when no seed is provided', () => {
    cy.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }] },
    });
    cy.visit('/');
    cy.getChaosSeed().then((seed) => {
      expect(seed).to.be.a('number');
      expect(Number.isInteger(seed)).to.be.true;
    });
  });

  it('seed works with probability 1.0  -  always applies', () => {
    cy.injectChaos({
      seed: SEED,
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }] },
    });
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Error!');
    cy.get('#result').should('contain', '503');
  });

  it('seed works with probability 0  -  never applies', () => {
    cy.injectChaos({
      seed: SEED,
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 0 }] },
    });
    cy.visit('/');
    cy.get('#fetch-data').click();
    cy.get('#status').should('have.text', 'Success!');
  });
});
