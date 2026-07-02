// Minimal chunked HTTP server for chaos-maker fetch-stream E2E tests.
//
// Exposes `/chat` which streams `n` text chunks (default 5) every
// `intervalMs` (default 60). Each chunk is one line, e.g. `chunk-3\n`, so a
// browser-side reader can count chunks and concatenate text. Mirrors the
// shape a real chat backend would use (chunked `text/plain` body consumed via
// `fetch(...).body.getReader()`), letting the parity catalog drive the
// fetch-stream interceptor end-to-end.
//
// Kept as plain JS so Playwright `webServer` / Cypress / WDIO / Puppeteer can
// `node` it directly without a build step.

const http = require('node:http');

const PORT = Number(process.env.CHAT_PORT || 8084);

function writeCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function streamChat(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const n = Math.max(1, Math.min(50, Number(url.searchParams.get('n') || 5)));
  const intervalMs = Math.max(0, Math.min(2000, Number(url.searchParams.get('intervalMs') || 60)));
  // `toolcall=1` swaps the third message for a tool-call payload line, the
  // wire marker chat backends emit when the model requests a function call.
  // Lets streaming tests target content-matched chaos at the structured
  // payload while prose lines stream through untouched.
  const toolcall = url.searchParams.get('toolcall') === '1';

  // No Content-Length: Node streams the body with chunked framing, matching
  // how a real chat backend delivers tokens. Consumers must not assert on raw
  // ReadableStream chunk counts: Firefox and WebKit may coalesce buffered
  // writes into one chunk, so the fixture page also exposes a per-message
  // count derived from newline-terminated lines.
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Access-Control-Allow-Origin': '*',
  });

  let i = 0;
  let timerId = null;
  const tick = () => {
    if (i >= n) {
      try { res.end(); } catch { /* socket already gone */ }
      return;
    }
    try {
      if (toolcall && i === 2) {
        res.write('{"tool_calls":[{"id":"call_1","name":"lookup"}]}\n');
      } else {
        res.write(`chunk-${i}\n`);
      }
    } catch {
      return;
    }
    i += 1;
    timerId = setTimeout(tick, intervalMs);
  };
  // Kick off async so the response headers flush first; the browser's
  // fetch promise resolves before any chunk arrives.
  timerId = setTimeout(tick, intervalMs);

  req.on('close', () => {
    i = n;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    writeCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (parsedUrl.pathname === '/chat' && req.method === 'GET') {
    streamChat(req, res);
    return;
  }

  if (parsedUrl.pathname === '/healthz') {
    writeCors(res);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  writeCors(res);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[chat] listening on http://127.0.0.1:${PORT}`);
});

const close = () => server.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
