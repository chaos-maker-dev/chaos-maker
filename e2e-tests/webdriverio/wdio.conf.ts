import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { registerChaosCommands, registerSWChaosCommands } from '@chaos-maker/webdriverio';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const browserName = process.env.WDIO_BROWSER || 'chrome';

// Strip NODE_OPTIONS from spawned-fixture child processes. ts-node's ESM
// loader registers itself via NODE_OPTIONS so child Node processes inherit
// it; the http-server bin script has no `.ts`/`.js` extension and ts-node's
// `getFormat` returns null on it, crashing the child before it can listen.
// Fixture servers do not need any TypeScript handling, so unset the variable.
const fixtureEnv = (): NodeJS.ProcessEnv => ({ ...process.env, NODE_OPTIONS: '' });

let httpServer: ChildProcess | null = null;
let wsServer: ChildProcess | null = null;
let sseServer: ChildProcess | null = null;
let graphqlServer: ChildProcess | null = null;

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200) return;
    } catch {
      /* not yet up */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Fixture server at ${url} did not start within ${timeoutMs}ms`);
}

function probeTcp(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

async function waitForTcp(host: string, port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeTcp(host, port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Fixture server at ${host}:${port} did not start within ${timeoutMs}ms`);
}

function capabilities(): WebdriverIO.Capabilities[] {
  if (browserName === 'firefox') {
    return [
      {
        browserName: 'firefox',
        'moz:firefoxOptions': {
          args: ['-headless'],
        },
      },
    ];
  }
  return [
    {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
      },
    },
  ];
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  tsConfigPath: './tsconfig.json',
  specs: ['./tests/**/*.spec.ts'],
  maxInstances: 1,
  capabilities: capabilities(),
  logLevel: 'warn',
  baseUrl: 'http://127.0.0.1:8080',
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60_000,
  },
  async onPrepare() {
    let httpReady = false;
    try {
      await fetch('http://127.0.0.1:8080');
      httpReady = true;
    } catch {
      /* will start HTTP fixture below */
    }
    const wsReady = await probeTcp('127.0.0.1', 8081);
    const sseReady = await probeTcp('127.0.0.1', 8082);
    const graphqlReady = await probeTcp('127.0.0.1', 8083);

    if (!httpReady) {
      httpServer = spawn(
        PNPM_BIN,
        ['exec', 'http-server', FIXTURES, '-p', '8080', '-s'],
        { stdio: 'inherit', env: fixtureEnv() },
      );
    }
    if (!wsReady) {
      wsServer = spawn(
        'node',
        [resolve(FIXTURES, 'ws-echo-server.cjs')],
        { stdio: 'inherit', env: fixtureEnv() },
      );
    }
    if (!sseReady) {
      sseServer = spawn(
        'node',
        [resolve(FIXTURES, 'sse-server.cjs')],
        { stdio: 'inherit', env: fixtureEnv() },
      );
    }
    if (!graphqlReady) {
      graphqlServer = spawn(
        'node',
        [resolve(FIXTURES, 'graphql-server.cjs')],
        { stdio: 'inherit', env: fixtureEnv() },
      );
    }
    if (!httpReady) await waitForHttp('http://127.0.0.1:8080');
    if (!wsReady) await waitForTcp('127.0.0.1', 8081);
    if (!sseReady) await waitForTcp('127.0.0.1', 8082);
    if (!graphqlReady) await waitForTcp('127.0.0.1', 8083);
  },
  onComplete() {
    httpServer?.kill();
    wsServer?.kill();
    sseServer?.kill();
    graphqlServer?.kill();
    httpServer = null;
    wsServer = null;
    sseServer = null;
    graphqlServer = null;
  },
  async before() {
    registerChaosCommands(browser as never);
    registerSWChaosCommands(browser as never);
  },
  async afterTest() {
    // Auto-cleanup chaos between tests so leftover patched fetch/XHR/WS
    // doesn't leak into the next spec.
    try {
      await browser.execute(() => {
        const w = window as unknown as { chaosUtils?: { stop?: () => void } };
        if (w.chaosUtils && typeof w.chaosUtils.stop === 'function') {
          w.chaosUtils.stop();
        }
      });
    } catch {
      /* page may already be navigating — fine */
    }
  },
};
