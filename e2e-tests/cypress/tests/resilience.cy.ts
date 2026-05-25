// Baseline tests  -  verify the AUT works correctly without any chaos injected.
// If these fail, chaos-specific failures elsewhere are suspect (page under
// test is broken, not the chaos adapter).

it('fetches and displays data without chaos', () => {
  cy.visit('/');
  cy.get('#fetch-data').click();
  cy.get('#status').should('have.text', 'Success!');
  cy.get('#result').should('contain', '"userId": 1');
});

it('XHR fetches data without chaos', () => {
  cy.visit('/');
  cy.get('#xhr-get').click();
  cy.get('#xhr-status').should('have.text', 'Success!');
  cy.get('#xhr-result').should('contain', '"userId": 1');
});
