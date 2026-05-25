import { loadCoreUmdSource } from './umd-loader';

/**
 * Minimal shape of Cypress's `on` callback that we need  -  a function that
 * registers task handlers. Declared locally so this module does not have to
 * import from `cypress` (which pulls browser types into the Node-side plugin).
 */
type PluginOn = (event: 'task', tasks: Record<string, (arg?: unknown) => unknown>) => void;

/**
 * Register chaos-maker's Cypress tasks on the plugins-process `on` handler.
 *
 * Call from `cypress.config.ts`:
 *
 * ```ts
 * import { defineConfig } from 'cypress';
 * import { registerChaosTasks } from '@chaos-maker/cypress/tasks';
 *
 * export default defineConfig({
 *   e2e: {
 *     setupNodeEvents(on) {
 *       registerChaosTasks(on);
 *     },
 *   },
 * });
 * ```
 *
 * Registered tasks:
 * - `chaos:getUmdSource`  -  returns the `@chaos-maker/core` UMD bundle as a
 *   string. The support-side `cy.injectChaos` command calls this once per
 *   spec, caches the result, and evaluates it inside the AUT window.
 */
export function registerChaosTasks(on: PluginOn): void {
  on('task', {
    'chaos:getUmdSource': () => loadCoreUmdSource(),
  });
}
