import { catalog } from '../../fixtures/parity/catalog';
import { registerScenario } from './_parity-runner';

describe('Matcher parity', () => {
  for (const scenario of catalog) {
    registerScenario(scenario);
  }
});
