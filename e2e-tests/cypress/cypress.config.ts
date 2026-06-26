import { defineConfig } from 'cypress';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { registerChaosTasks } from '@chaos-maker/cypress/tasks';

// __dirname is available because Cypress compiles this file to CJS.
const FIXTURES = path.resolve(__dirname, '../fixtures');
const BUNX_BIN = process.platform === 'win32' ? 'bunx.cmd' : 'bunx';

let httpServer: ChildProcess | null = null;
let wsServer: ChildProcess | null = null;
let sseServer: ChildProcess | null = null;
let graphqlServer: ChildProcess | null = null;
let chatServer: ChildProcess | null = null;

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise<void>((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Server at ${url} did not respond within ${timeoutMs}ms`);
}

export default defineConfig({
  e2e: {
    baseUrl: 'http://127.0.0.1:8080',
    // Flattened layout to mirror Playwright's `tests/` convention for cross-
    // framework consistency in this monorepo. Cypress's default is
    // `cypress/e2e/` + `cypress/support/`, which would nest awkwardly inside
    // this workspace package's own `cypress/` leaf directory.
    supportFile: 'support/e2e.ts',
    specPattern: 'tests/**/*.cy.ts',
    // Explicit output folders so Cypress doesn't fall back to its defaults
    // (`cypress/videos`, `cypress/screenshots`, `cypress/downloads`) and
    // recreate the nested `cypress/` directory we just flattened away.
    videosFolder: 'videos',
    screenshotsFolder: 'screenshots',
    downloadsFolder: 'downloads',
    video: false,
    // setupNodeEvents is awaited by Cypress before the baseUrl reachability
    // check, so starting servers here ensures they are ready in time.
    async setupNodeEvents(on, config) {
      registerChaosTasks(on);

      // Reuse already-running servers in local dev to avoid port conflicts.
      let alreadyUp = false;
      try {
        await fetch('http://127.0.0.1:8080');
        alreadyUp = true;
      } catch {
        /* not running  -  start our own */
      }

      if (!alreadyUp) {
        httpServer = spawn(
          BUNX_BIN,
          ['http-server', FIXTURES, '-p', '8080', '-s'],
          { stdio: 'pipe' },
        );
        wsServer = spawn(
          'node',
          [path.join(FIXTURES, 'ws-echo-server.cjs')],
          { stdio: 'pipe' },
        );
        sseServer = spawn(
          'node',
          [path.join(FIXTURES, 'sse-server.cjs')],
          { stdio: 'pipe' },
        );
        graphqlServer = spawn(
          'node',
          [path.join(FIXTURES, 'graphql-server.cjs')],
          { stdio: 'pipe' },
        );
        chatServer = spawn(
          'node',
          [path.join(FIXTURES, 'chat-server.cjs')],
          { stdio: 'pipe' },
        );
        await waitForHttp('http://127.0.0.1:8080');
        await waitForHttp('http://127.0.0.1:8082/healthz');
        await waitForHttp('http://127.0.0.1:8083/healthz');
        await waitForHttp('http://127.0.0.1:8084/healthz');
      }

      on('after:run', () => {
        httpServer?.kill();
        wsServer?.kill();
        sseServer?.kill();
        graphqlServer?.kill();
        chatServer?.kill();
        httpServer = null;
        wsServer = null;
        sseServer = null;
        graphqlServer = null;
        chatServer = null;
      });

      return config;
    },
  },
});
