import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../../fixtures');
const BUNX_BIN = process.platform === 'win32' ? 'bunx.cmd' : 'bunx';

let httpServer: ChildProcess | null = null;
let wsServer: ChildProcess | null = null;
let sseServer: ChildProcess | null = null;
let graphqlServer: ChildProcess | null = null;

function probeTcp(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
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
  throw new Error(`Server at ${host}:${port} did not start within ${timeoutMs}ms`);
}

export async function setup(): Promise<void> {
  const httpReady = await probeTcp('127.0.0.1', 8080);
  const wsReady = await probeTcp('127.0.0.1', 8081);
  const sseReady = await probeTcp('127.0.0.1', 8082);
  const graphqlReady = await probeTcp('127.0.0.1', 8083);

  if (!httpReady) {
    httpServer = spawn(
      BUNX_BIN,
      ['http-server', FIXTURES, '-p', '8080', '-s'],
      { stdio: 'inherit' },
    );
    await waitForTcp('127.0.0.1', 8080);
  }

  if (!wsReady) {
    wsServer = spawn(
      'node',
      [resolve(FIXTURES, 'ws-echo-server.cjs')],
      { stdio: 'inherit' },
    );
    await waitForTcp('127.0.0.1', 8081);
  }

  if (!sseReady) {
    sseServer = spawn(
      'node',
      [resolve(FIXTURES, 'sse-server.cjs')],
      { stdio: 'inherit' },
    );
    await waitForTcp('127.0.0.1', 8082);
  }

  if (!graphqlReady) {
    graphqlServer = spawn(
      'node',
      [resolve(FIXTURES, 'graphql-server.cjs')],
      { stdio: 'inherit' },
    );
    await waitForTcp('127.0.0.1', 8083);
  }
}

export async function teardown(): Promise<void> {
  httpServer?.kill();
  wsServer?.kill();
  sseServer?.kill();
  graphqlServer?.kill();
  httpServer = null;
  wsServer = null;
  sseServer = null;
  graphqlServer = null;
}
