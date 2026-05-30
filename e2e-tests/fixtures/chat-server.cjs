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

  // Build every chunk upfront so a fixed Content-Length can be sent. A
  // fixed-length response is delivered with Transfer-Encoding: identity, not
  // chunked. Playwright's Firefox rejects a cross-origin CHUNKED response with
  // NS_ERROR_DOM_BAD_URI when the request is initiated from page (DOM) context,
  // but accepts a fixed-length one. The bytes are still written incrementally
  // with a delay between them, so the browser's `body.getReader()` yields a
  // chunk per write and the streaming-chaos pipeline still exercises each one.
  const chunks = [];
  for (let k = 0; k < n; k += 1) chunks.push(Buffer.from(`chunk-${k}\n`));
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Content-Length': String(total),
    'Access-Control-Allow-Origin': '*',
  });

  let i = 0;
  const tick = () => {
    if (i >= chunks.length) {
      try { res.end(); } catch { /* socket already gone */ }
      return;
    }
    try {
      res.write(chunks[i]);
    } catch {
      return;
    }
    i += 1;
    setTimeout(tick, intervalMs);
  };
  // Kick off async so the response headers flush first; the browser's
  // fetch promise resolves before any chunk arrives.
  setTimeout(tick, intervalMs);

  req.on('close', () => { i = chunks.length; });
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
