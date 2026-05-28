import type { Scenario } from './types';
import { networkScenarios } from './network';
import { builtInScenarios } from './built-in';
import { webSocketScenarios } from './websocket';
import { sseScenarios } from './sse';
import { fetchStreamScenarios } from './fetch-stream';

/** The single source of truth for cross-adapter matcher parity. Every
 *  adapter's E2E suite runs this exact catalog through its own thin
 *  interpreter, so each matcher behaves identically on Playwright, Cypress,
 *  WebdriverIO, and Puppeteer. */
export const catalog: Scenario[] = [
  ...networkScenarios,
  ...builtInScenarios,
  ...webSocketScenarios,
  ...sseScenarios,
  ...fetchStreamScenarios,
];
