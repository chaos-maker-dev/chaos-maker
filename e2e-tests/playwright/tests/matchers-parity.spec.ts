import { test } from '@playwright/test';
import { catalog } from '../../fixtures/parity/catalog';
import { registerScenario } from './_parity-runner';

test.describe('Matcher parity', () => {
  for (const scenario of catalog) {
    registerScenario(scenario);
  }
});
